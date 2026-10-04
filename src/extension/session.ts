import { z } from 'zod';
import { PROVIDERS, PilotError, safeCode, exactOrigin, providerId, requestSchema, type Snapshot, type Binding, type ActionPlan, type DecisionRequest, type DecisionResult } from '../shared.js';
import { pageOperation, type PageInput } from './page.js';
import { summarize, type BenchmarkRow } from '../benchmark.js';
import {enforceRecipe} from './policy.js';
import {waitForTab,withInteractiveTab} from './readiness.js';
import {fileMetadataSchema} from '../file-contract.js';
import {fileOperation,type FilePageInput} from './file-actions.js';
import {createCapabilitySession} from './v2-session.js';

export function createBrowserSession(id:string,name:string,external:boolean,host:(command:string,payload?:unknown)=>Promise<any>,policy=()=>({mode:'takeover' as 'safe'|'takeover'|'readonly',vaultEnabled:true}),validateTab:(tabId:number)=>Promise<void>=async()=>{},allowedOrigins:()=>string[]=()=>[],siteToolsEnabled:()=>boolean=()=>false){
let binding:Binding|undefined,snapshot:Snapshot|undefined,recipe:ActionPlan['recipe']|'all'='click';
let pending:{id:string;plan:ActionPlan;expires:number}|undefined;
let generation=0,busy=false,running=false,closed=false,stepActive=false;
let capabilityStepActive=false;
let expectedNavigation:{tabId:number;origin:string;expires:number}|undefined;
let fileGeneration=0,activeFileTransfer:FilePageInput&{tabId:number;documentId:string;artifactIds:string[]}|undefined;
const capabilities=createCapabilitySession(id,()=>binding,policy,validateTab,()=>generation,allowedOrigins,tabId=>command('pin',{tabId}),siteToolsEnabled);
async function inDocument(input:PageInput) {
  if(!binding)throw new PilotError('no_bound_tab');
  if(input.op!=='cancel'){
    const run=generation;await validateTab(binding.tabId);
    if(run!==generation||!binding)throw new PilotError('cancelled');
    enforceRecipe(policy(),input.op==='execute'?input.recipe:input.op==='wait'||input.kind==='all'?'extract':input.kind);
  }
  const results=await chrome.scripting.executeScript({target:{tabId:binding.tabId,documentIds:[binding.documentId]},world:'ISOLATED',func:pageOperation,args:[input]});
  const result=results[0]?.result;if(!result?.ok)throw new PilotError(result?.code??'execution_failed');return result;
}
function decisionRequest(question:string,selectedRecipe=recipe):DecisionRequest {
  if(!binding||!snapshot)throw new PilotError('observe_first');
  const {documentToken,pageVersion,...page}=snapshot;
  return {requestId:crypto.randomUUID(),stateVersion:binding.documentId+':'+snapshot.documentToken,question,
    context:page,
    choices:[...snapshot.targets.filter(t=>selectedRecipe==='all'||selectedRecipe==='click'?selectedRecipe==='all'||['link','button'].includes(t.kind):selectedRecipe==='extract'?['table','text'].includes(t.kind):t.kind==='form'||selectedRecipe==='fill'&&t.kind==='select').map(t=>({id:t.id,description:`${t.kind}: ${t.section? t.section+' / ':''}${t.name}`.slice(0,300)})),{id:'ask_user',description:'Insufficient information or no suitable target. Ask the user.'}]};
}
async function command(name:string,payload:any):Promise<any> {
  if(name.startsWith('v2.')){
    if(!binding&&expectedNavigation&&['v2.state','v2.frames'].includes(name)){
      const candidate=expectedNavigation;if(candidate.expires<Date.now()){expectedNavigation=undefined;throw new PilotError('no_bound_tab');}
      await validateTab(candidate.tabId);await waitForTab(candidate.tabId,3000);
      const tab=await chrome.tabs.get(candidate.tabId),origin=exactOrigin(tab.url??'');
      if(origin!==candidate.origin&&!allowedOrigins().includes(origin))throw new PilotError('navigation_out_of_scope');
      if(expectedNavigation!==candidate||closed)throw new PilotError('cancelled');await command('pin',{tabId:candidate.tabId});
    }
    if(name==='v2.commit')capabilityStepActive=true;
    try{const result=await capabilities.command(name.slice(3),payload);if(name==='v2.commit'&&binding&&result.action?.dispatch==='sent')expectedNavigation={tabId:binding.tabId,origin:binding.origin,expires:Date.now()+3000};return result;}finally{capabilityStepActive=false;}
  }
    if(name==='files.invalidate'){
      const ids=z.object({artifactIds:z.array(z.string().uuid()).min(1).max(20)}).passthrough().parse(payload).artifactIds;
      if(!activeFileTransfer||!activeFileTransfer.artifactIds.some(id=>ids.includes(id)))return {invalidated:false};
      fileGeneration++;
    const transfer=activeFileTransfer;
    if(transfer)await chrome.scripting.executeScript({target:{tabId:transfer.tabId,documentIds:[transfer.documentId]},world:'ISOLATED',func:fileOperation,args:[{...transfer,op:'abort'}]}).catch(()=>{});
    return {invalidated:true};
  }
  if(name==='files.upload'){
    enforceRecipe(policy(),'fill');
    const input=z.object({ticket:z.string().uuid(),targetId:z.string().min(1).max(100),stateVersion:z.string().max(200),files:z.array(fileMetadataSchema).min(1).max(20)}).strict().parse(payload);
    if(!binding)throw new PilotError('stale_snapshot');
    const legacy=snapshot&&input.stateVersion===binding.documentId+':'+snapshot.documentToken;
    const resolved=legacy?{target:snapshot!.targets.find(t=>t.id===input.targetId),token:snapshot!.documentToken}:await capabilities.fileTarget(input.stateVersion,input.targetId);
    const {target,token}=resolved;if(target?.kind!=='file')throw new PilotError('stale_snapshot');
    const version=legacy?undefined:2 as const,bound={...binding},run=generation,fileRun=fileGeneration,transferId=crypto.randomUUID();let committing=false;
      activeFileTransfer={op:'abort',version,transferId,origin:bound.origin,token,targetId:input.targetId,tabId:bound.tabId,documentId:bound.documentId,artifactIds:input.files.map(f=>f.id)};
    const operation=async(op:FilePageInput['op'],extra:Partial<FilePageInput>={})=>{
      if(run!==generation||fileRun!==fileGeneration||closed||binding?.documentId!==bound.documentId)throw new PilotError('cancelled');
      enforceRecipe(policy(),'fill');await validateTab(bound.tabId);
      if(run!==generation||fileRun!==fileGeneration||closed)throw new PilotError('cancelled');
      if(!await chrome.permissions.contains({origins:[bound.origin+'/*']}))throw new PilotError('site_permission_required');
      const results=await chrome.scripting.executeScript({target:{tabId:bound.tabId,documentIds:[bound.documentId]},world:'ISOLATED',func:fileOperation,args:[{op,version,transferId,origin:bound.origin,token,targetId:input.targetId,...extra}]});
      const result=results[0]?.result;if(!result?.ok)throw new PilotError(result?.code??'execution_failed');return result;
    };
    busy=true;pending=undefined;
    try{
      await operation('start',{files:input.files,accept:target.accept??'',multiple:target.multiple??false});
      for(let index=0;index<input.files.length;index++){
        const file=input.files[index],chunks:Uint8Array[]=[];let offset=0;
        while(offset<file.size){
          const chunk=await host('files.read',{ticket:input.ticket,artifactId:file.id,offset});
          if(chunk.nextOffset<=offset)throw new PilotError('file_transfer_incomplete');
          const raw=atob(chunk.data),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
          if(chunk.nextOffset!==offset+bytes.length)throw new PilotError('invalid_file_chunk');
          chunks.push(bytes);await operation('chunk',{index,offset,data:chunk.data});offset=chunk.nextOffset;
        }
        // Extension workers are secure contexts even when the authorized site uses plain HTTP.
        const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await new Blob(chunks as BlobPart[]).arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');
        if(digest!==file.sha256)throw new PilotError('file_hash_mismatch');
      }
      await operation('seal');
      // Hashing is complete; recheck the host ticket even for empty files before dispatch.
      for(const file of input.files)await host('files.read',{ticket:input.ticket,artifactId:file.id,offset:file.size});
      committing=true;return await operation('commit');
      }catch(error){
        await chrome.scripting.executeScript({target:{tabId:bound.tabId,documentIds:[bound.documentId]},world:'ISOLATED',func:fileOperation,args:[{op:'abort',transferId,origin:bound.origin,token,targetId:input.targetId}]}).catch(()=>{});
        if(!committing&&(run!==generation||fileRun!==fileGeneration||closed))throw new PilotError('cancelled');
      if(committing&&!['stale_snapshot','target_not_ready','cancelled','file_hash_mismatch','file_access_revoked'].includes(safeCode(error)))throw new PilotError('action_outcome_unknown');throw error;
    }finally{busy=false;activeFileTransfer=undefined;}
  }
  if(['observe','decide','manual'].includes(name))enforceRecipe(policy(),name==='observe'&&payload?.recipe==='all'?'extract':payload?.recipe);
  // Human-owned native dialogs can block page JavaScript. Cancellation/release
  // must revoke local and host state without waiting for that human response.
  if(name==='cancel') {const handedOff=capabilities.isHandedOff();expectedNavigation=undefined;generation++;capabilities.invalidate();pending=undefined;snapshot=undefined;if(!handedOff)await inDocument({op:'cancel'}).catch(()=>{});await host('cancel');return {cancelled:true};}
  if(name==='status')return {...await host('status'),binding,snapshot,busy};
  if(busy)throw new PilotError('busy');
  if(name==='pin') {
    expectedNavigation=undefined;
    const run=generation;
    const tabId=z.number().int().nonnegative().parse(payload?.tabId);
    const tab=await chrome.tabs.get(tabId),origin=exactOrigin(tab.url??'');
    if(!await chrome.permissions.contains({origins:[origin+'/*']}))throw new PilotError('site_permission_required');
    const docs=await chrome.scripting.executeScript({target:{tabId},func:()=>location.origin});
    const top=docs[0];if(!top?.documentId||top.result!==origin)throw new PilotError('stale_binding');
    if(run!==generation||closed)throw new PilotError('cancelled');
    capabilities.invalidate();generation++;pending=undefined;snapshot=undefined;binding={tabId,documentId:top.documentId,origin};
    await host('bind',binding);if(generation!==run+1||closed)throw new PilotError('cancelled');return binding;
  }
  if(name==='observe') {
    const run=generation;
    recipe=z.enum(['click','fill','login','extract','all']).parse(payload?.recipe);pending=undefined;
    const result=await inDocument({op:'observe',kind:recipe});if(run!==generation||closed)throw new PilotError('cancelled');snapshot=result.snapshot;return result;
  }
  if(name==='decide') {
    const input=z.object({recipe:z.enum(['click','fill','login','extract']),provider:providerId,question:z.string().min(1).max(2000),fields:z.record(z.string(),z.string().max(2000)).optional(),selectOptionIndex:z.number().int().min(0).max(39).optional(),credentialId:z.string().uuid().optional()}).strict().parse(payload);
    if(input.selectOptionIndex!==undefined&&(input.recipe!=='fill'||input.fields!==undefined))throw new PilotError('invalid_fields');
    if(input.recipe!==recipe&&recipe!=='all')throw new PilotError('observe_first');
    const request=decisionRequest(input.question,input.recipe);if(request.choices.length<2)throw new PilotError('no_candidates');
    const run=generation;busy=true;pending=undefined;
    try {
      const result:DecisionResult=await host('decide',{provider:input.provider,request});
      if(generation!==run)throw new PilotError('cancelled');
      if(result.status==='selected'&&result.choiceId!=='ask_user'){
        if(!snapshot!.targets.some(t=>t.id===result.choiceId))throw new PilotError('invalid_response');
        pending={id:crypto.randomUUID(),expires:Date.now()+60000,plan:{binding:binding!,snapshot:snapshot!,recipe:input.recipe,targetId:result.choiceId!,fields:input.fields,selectOptionIndex:input.selectOptionIndex,credentialId:input.credentialId}};
      }
      return {result,target:snapshot!.targets.find(t=>t.id===result.choiceId),canExecute:!!pending,actionId:pending?.id};
    } finally {busy=false;}
  }
  if(name==='manual') {
    const input=z.object({recipe:z.enum(['click','fill','login','extract']),targetId:z.string(),fields:z.record(z.string(),z.string().max(2000)).optional(),selectOptionIndex:z.number().int().min(0).max(39).optional(),credentialId:z.string().uuid().optional()}).strict().parse(payload);
    if(input.selectOptionIndex!==undefined&&(input.recipe!=='fill'||input.fields!==undefined))throw new PilotError('invalid_fields');
    if(input.recipe!==recipe&&recipe!=='all')throw new PilotError('observe_first');
    if(!binding||!snapshot||!snapshot.targets.some(t=>t.id===input.targetId))throw new PilotError('observe_first');
    pending={id:crypto.randomUUID(),expires:Date.now()+60000,plan:{binding,snapshot,recipe:input.recipe,targetId:input.targetId,fields:input.fields,selectOptionIndex:input.selectOptionIndex,credentialId:input.credentialId}};
    return {target:snapshot.targets.find(t=>t.id===input.targetId),canExecute:true,manual:true,actionId:pending.id};
  }
  if(name==='select'){
    const input=z.object({provider:providerId,request:z.unknown()}).strict().parse(payload);
    const request=requestSchema.parse(input.request);
    if(!binding||(!snapshot||request.stateVersion!==binding.documentId+':'+snapshot.documentToken)&&!await capabilities.validateVersion(request.stateVersion))throw new PilotError('stale_snapshot');
    if(request.images?.length)await capabilities.validateImages(request.images);
    const run=generation;busy=true;
    try{const result=await host('decide',input);if(run!==generation||closed)throw new PilotError('cancelled');return result;}finally{busy=false;}
  }
  if(name==='step'){
    const input=z.object({actionId:z.string().uuid(),stateVersion:z.string().min(1).max(200),expect:z.enum(['change','navigation','none']).optional(),timeoutMs:z.number().int().min(100).max(15000).default(8000)}).strict().parse(payload);
    if(!binding||!snapshot||input.stateVersion!==binding.documentId+':'+snapshot.documentToken||pending?.id!==input.actionId)throw new PilotError('stale_snapshot');
    const previous=binding,before=snapshot,plan=pending.plan,run=generation,start=performance.now();
    stepActive=plan.recipe==='click';let action:any,actionError:unknown;
    try{
      try{action=await command('execute',{actionId:input.actionId});}catch(error){actionError=error;if(binding||generation!==run)throw error;}
      const executed=performance.now();
      if(generation!==run||closed)throw new PilotError('cancelled');
      let changed=false;
      if(plan.recipe==='click'&&input.expect!=='none'){
        try{if(binding)changed=(await inDocument({op:'wait',version:before.pageVersion??'',timeoutMs:input.timeoutMs})).changed;}catch{/* A destroyed document is checked through its tab below. */}
      }
      await waitForTab(previous.tabId,input.timeoutMs);
      if(generation!==run||closed)throw new PilotError('cancelled');
      const tab=await chrome.tabs.get(previous.tabId);
      if(exactOrigin(tab.url??'')!==previous.origin)throw new PilotError('navigation_out_of_scope');
      const expected=before.targets.find(t=>t.id===plan.targetId)?.href;
      if(expected&&expected!==before.path&&new URL(tab.url!).pathname+new URL(tab.url!).search!==expected)throw new PilotError('unexpected_navigation');
      const waited=performance.now();
      if(!binding)await command('pin',{tabId:previous.tabId});
      const observed=await command('observe',{recipe:'all'});
      const navigated=binding!.documentId!==previous.documentId||observed.snapshot.path!==before.path;
      const transitioned=navigated||changed||observed.snapshot.pageVersion!==before.pageVersion;
      return {action:action??{ok:false,code:safeCode(actionError),outcome:'unknown'},binding,snapshot:observed.snapshot,
        readiness:{state:(input.expect==='navigation'?navigated:input.expect==='none'||plan.recipe!=='click'||transitioned)?'observed':'timeout',navigated,changed:transitioned,businessOutcomeVerified:false},
        timings:{actionMs:Math.round(executed-start),waitMs:Math.round(waited-executed),observeMs:Math.round(performance.now()-waited),totalMs:Math.round(performance.now()-start)}};
    }finally{stepActive=false;}
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
      return await inDocument({op:'execute',origin:plan.binding.origin,token:plan.snapshot.documentToken,targetId:plan.targetId,recipe:plan.recipe,fields:plan.fields,selectOptionIndex:plan.selectOptionIndex,credential});
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
    if(['cancel','status','files.invalidate'].includes(name))return command(name,payload);
    if(running)throw new PilotError('busy');running=true;
    try{
      const interactive=name==='step'||name==='execute'||name==='files.upload';
      const writing=name==='files.upload'||pending&&pending.plan.recipe!=='extract';
      if(interactive&&writing&&binding){
        const tabId=binding.tabId,run=generation;
        return await withInteractiveTab(tabId,async()=>{
          if(closed||generation!==run||binding?.tabId!==tabId)throw new PilotError('cancelled');
          if(name!=='files.upload'&&(!pending||pending.expires<Date.now()||payload?.actionId&&payload.actionId!==pending.id))throw new PilotError('decision_expired');
          enforceRecipe(policy(),name==='files.upload'?'fill':pending!.plan.recipe);await validateTab(tabId);
          if(closed||generation!==run||binding?.tabId!==tabId)throw new PilotError('cancelled');
        },()=>command(name,payload));
      }
      return await command(name,payload);
    }finally{running=false;}
  },
  invalidate(notify=true,navigation=false){if(navigation&&capabilityStepActive){pending=undefined;snapshot=undefined;return;}const expected=navigation&&expectedNavigation&&expectedNavigation.expires>=Date.now();if(!navigation)expectedNavigation=undefined;if(!navigation||!stepActive)generation++;capabilities.invalidate();pending=undefined;snapshot=undefined;binding=undefined;if(notify&&!stepActive&&!expected)void host(navigation?'cancel':'release').catch(()=>{});},
  async release(){const handedOff=capabilities.isHandedOff();closed=true;generation++;capabilities.invalidate();pending=undefined;snapshot=undefined;if(!handedOff)await inDocument({op:'cancel'}).catch(()=>{});binding=undefined;await host('release');},
};
}
export type BrowserSession=ReturnType<typeof createBrowserSession>;
