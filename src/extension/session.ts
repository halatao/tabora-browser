import { z } from 'zod';
import { PROVIDERS, PilotError, safeCode, exactOrigin, providerId, type Snapshot, type Binding, type ActionPlan, type DecisionRequest, type DecisionResult } from '../shared.js';
import { pageOperation, type PageInput } from './page.js';
import { summarize, type BenchmarkRow } from '../benchmark.js';
import {enforceRecipe} from './policy.js';

export function createBrowserSession(id:string,name:string,external:boolean,host:(command:string,payload?:unknown)=>Promise<any>,policy=()=>({mode:'takeover' as 'safe'|'takeover'|'readonly',vaultEnabled:true}),validateTab:(tabId:number)=>Promise<void>=async()=>{}){
let binding:Binding|undefined,snapshot:Snapshot|undefined,recipe:ActionPlan['recipe']='click';
let pending:{id:string;plan:ActionPlan;expires:number}|undefined;
let generation=0,busy=false,running=false,closed=false;
async function inDocument(input:PageInput) {
  if(!binding)throw new PilotError('no_bound_tab');
  if(input.op!=='cancel'){
    const run=generation;await validateTab(binding.tabId);
    if(run!==generation||!binding)throw new PilotError('cancelled');
    enforceRecipe(policy(),input.op==='execute'?input.recipe:input.kind);
  }
  const results=await chrome.scripting.executeScript({target:{tabId:binding.tabId,documentIds:[binding.documentId]},world:'ISOLATED',func:pageOperation,args:[input]});
  const result=results[0]?.result;if(!result?.ok)throw new PilotError(result?.code??'execution_failed');return result;
}
function decisionRequest(question:string):DecisionRequest {
  if(!binding||!snapshot)throw new PilotError('observe_first');
  return {requestId:crypto.randomUUID(),stateVersion:binding.documentId+':'+snapshot.documentToken,question,
    context:{origin:snapshot.origin,targets:snapshot.targets},
    choices:[...snapshot.targets.map(t=>({id:t.id,description:`${t.kind}: ${t.name}`})),{id:'ask_user',description:'Insufficient information or no suitable target. Ask the user.'}]};
}
async function command(name:string,payload:any) {
  if(['observe','decide','manual'].includes(name))enforceRecipe(policy(),payload?.recipe);
  if(name==='cancel') {generation++;pending=undefined;snapshot=undefined;await inDocument({op:'cancel'}).catch(()=>{});await host('cancel');return {cancelled:true};}
  if(name==='status')return {...await host('status'),binding,snapshot,busy};
  if(busy)throw new PilotError('busy');
  if(name==='pin') {
    const run=generation;
    const tabId=z.number().int().nonnegative().parse(payload?.tabId);
    const tab=await chrome.tabs.get(tabId),origin=exactOrigin(tab.url??'');
    if(!await chrome.permissions.contains({origins:[origin+'/*']}))throw new PilotError('site_permission_required');
    const docs=await chrome.scripting.executeScript({target:{tabId},func:()=>location.origin});
    const top=docs[0];if(!top?.documentId||top.result!==origin)throw new PilotError('stale_binding');
    if(run!==generation||closed)throw new PilotError('cancelled');
    generation++;pending=undefined;snapshot=undefined;binding={tabId,documentId:top.documentId,origin};
    await host('bind',binding);if(generation!==run+1||closed)throw new PilotError('cancelled');return binding;
  }
  if(name==='observe') {
    const run=generation;
    recipe=z.enum(['click','fill','login','extract']).parse(payload?.recipe);pending=undefined;
    const result=await inDocument({op:'observe',kind:recipe});if(run!==generation||closed)throw new PilotError('cancelled');snapshot=result.snapshot;return result;
  }
  if(name==='decide') {
    const input=z.object({recipe:z.enum(['click','fill','login','extract']),provider:providerId,question:z.string().min(1).max(2000),fields:z.record(z.string(),z.string().max(2000)).optional(),credentialId:z.string().uuid().optional()}).strict().parse(payload);
    if(input.recipe!==recipe)throw new PilotError('observe_first');
    const request=decisionRequest(input.question);if(request.choices.length<2)throw new PilotError('no_candidates');
    const run=generation;busy=true;pending=undefined;
    try {
      const result:DecisionResult=await host('decide',{provider:input.provider,request});
      if(generation!==run)throw new PilotError('cancelled');
      if(result.status==='selected'&&result.choiceId!=='ask_user'){
        if(!snapshot!.targets.some(t=>t.id===result.choiceId))throw new PilotError('invalid_response');
        pending={id:crypto.randomUUID(),expires:Date.now()+60000,plan:{binding:binding!,snapshot:snapshot!,recipe,targetId:result.choiceId!,fields:input.fields,credentialId:input.credentialId}};
      }
      return {result,target:snapshot!.targets.find(t=>t.id===result.choiceId),canExecute:!!pending,actionId:pending?.id};
    } finally {busy=false;}
  }
  if(name==='manual') {
    const input=z.object({recipe:z.enum(['click','fill','login','extract']),targetId:z.string(),fields:z.record(z.string(),z.string().max(2000)).optional(),credentialId:z.string().uuid().optional()}).strict().parse(payload);
    if(input.recipe!==recipe)throw new PilotError('observe_first');
    if(!binding||!snapshot||!snapshot.targets.some(t=>t.id===input.targetId))throw new PilotError('observe_first');
    pending={id:crypto.randomUUID(),expires:Date.now()+60000,plan:{binding,snapshot,recipe,targetId:input.targetId,fields:input.fields,credentialId:input.credentialId}};
    return {target:snapshot.targets.find(t=>t.id===input.targetId),canExecute:true,manual:true,actionId:pending.id};
  }
  if(name==='execute') {
    if(!pending||pending.expires<Date.now()||(payload?.actionId&&payload.actionId!==pending.id))throw new PilotError('decision_expired');
    const {plan}=pending;pending=undefined;busy=true;const run=generation;
    try {
      enforceRecipe(policy(),plan.recipe);
      let credential:{username:string;password:string}|undefined;
      if(plan.recipe==='login'){
        if(!plan.credentialId)throw new PilotError('select_credential');
        credential=await host('credential.use',{id:plan.credentialId,binding:plan.binding});
      }
      if(run!==generation)throw new PilotError('cancelled');
      enforceRecipe(policy(),plan.recipe);
      return await inDocument({op:'execute',origin:plan.binding.origin,token:plan.snapshot.documentToken,targetId:plan.targetId,recipe:plan.recipe,fields:plan.fields,credential});
    } finally {busy=false;}
  }
  if(name==='benchmark') {
    const input=z.object({question:z.string().min(1).max(2000),repetitions:z.number().int().min(1).max(10),expectedChoiceId:z.string().optional()}).strict().parse(payload);
    const base=decisionRequest(input.question);if(base.choices.length<2)throw new PilotError('no_candidates');
    if(input.expectedChoiceId&&!base.choices.some(c=>c.id===input.expectedChoiceId))throw new PilotError('invalid_expected_choice');
    const rows:BenchmarkRow[]=[];const run=generation;busy=true;pending=undefined;
    try {
      for(let sample=0;sample<input.repetitions;sample++) {
        const order=[...PROVIDERS.slice(sample%4),...PROVIDERS.slice(0,sample%4)];
        for(const provider of order) {
          if(run!==generation)return {rows,summary:summarize(rows),cancelled:true};
          const request={...base,requestId:crypto.randomUUID()};let result:DecisionResult;const start=performance.now();
          try{result=await host('decide',{provider,request});}
          catch(error){result={requestId:request.requestId,stateVersion:request.stateVersion,provider,model:'',status:'failed',code:safeCode(error),latencyMs:Math.round(performance.now()-start)};}
          rows.push({provider,model:result.model,sample,expectedChoiceId:input.expectedChoiceId,result});
          void chrome.runtime.sendMessage({event:'benchmark-progress',rows,summary:summarize(rows)}).catch(()=>{});
        }
      }
      return {rows,summary:summarize(rows),complete:PROVIDERS.every(p=>rows.some(r=>r.provider===p&&r.result.status==='selected'))};
    } finally {busy=false;}
  }
  throw new PilotError('unknown_command');
}

return {
  id,name,external,
  get binding(){return binding;},
  get busy(){return busy||running;},
  async invoke(name:string,payload?:any){
    if(closed)throw new PilotError('session_closed');
    if(['cancel','status'].includes(name))return command(name,payload);
    if(running)throw new PilotError('busy');running=true;
    try{return await command(name,payload);}finally{running=false;}
  },
  invalidate(notify=true){generation++;pending=undefined;snapshot=undefined;binding=undefined;if(notify)void host('release').catch(()=>{});},
  async release(){closed=true;generation++;pending=undefined;snapshot=undefined;await inDocument({op:'cancel'}).catch(()=>{});binding=undefined;await host('release');},
};
}
export type BrowserSession=ReturnType<typeof createBrowserSession>;
