import {randomUUID} from 'node:crypto';
import {PilotError,safeCode,type DecisionResult,type ProviderId} from '../shared.js';
import {executeWorkflow} from './workflow.js';
import {imageDecisionCapability} from '../shared.js';
import type {z} from 'zod';
import type {workflowSchema} from '../browser-api.js';
type RunOptions={maxSteps:number;timeoutMs:number;readonly:boolean;task?:boolean;workflow?:z.infer<typeof workflowSchema>};

/** Execution identity is diagnostic, not a client-selectable bypass of policy. */
export type RunExecution={engine:'workflow-v2';contractVersion:1|2;goalPlanning:'grounded-goal'|'caller-workflow'};
function executionIdentity(options:RunOptions):RunExecution{
  return options.workflow
    ?{engine:'workflow-v2',contractVersion:2,goalPlanning:'caller-workflow'}
    :{engine:'workflow-v2',contractVersion:2,goalPlanning:'grounded-goal'};
}

export {answerFacts,listAnswerFacts,relevantFacts} from './evidence-facts.js';
import type {Evidence} from './evidence-facts.js';
export type RunPhase='admission'|'observation'|'planning'|'decision'|'dispatch'|'verification'|'recovery'|'terminal';
export type RunMetrics={decisions:number;actions:number;reads:number;calls:number;timeMs:Partial<Record<RunPhase,number>>};
export type RunStatus={phase?:RunPhase;metrics?:RunMetrics;id:string;sessionId:string;provider:ProviderId;status:'running'|'completed'|'needs_input'|'failed'|'cancelled';answer?:string;answerValues?:string[];artifacts?:import('../file-contract.js').FileMetadata[];evidence?:Evidence;code?:string;elapsedMs:number;steps:number;trace:{step:number;choiceId?:string;provider?:ProviderId;modality?:'text'|'vision';observationMs?:number;model?:string;providerMs?:number;operationMs?:number;actionType?:string;dispatch?:string;outcome?:string;targetKind?:string;targetName?:string;path?:string;stage?:'prepare'|'step';code?:string;timings?:unknown;usage?:DecisionResult['usage'];diagnostics?:DecisionResult['diagnostics'];runtime?:DecisionResult['runtime']}[]};
type Run={owner:string;profileId:string;status:RunStatus & {execution:RunExecution};controller:AbortController;call:(command:string,payload?:unknown)=>Promise<any>;started:number;expires?:NodeJS.Timeout};
export class RunController {
  private runs=new Map<string,Run>();
  constructor(private redact:(value:any)=>any=value=>value){}
  start(owner:string,profileId:string,sessionId:string,provider:ProviderId,goal:string,call:Run['call'],options:RunOptions){
    if([...this.runs.values()].some(r=>r.profileId===profileId&&r.status.sessionId===sessionId&&r.status.status==='running'))throw new PilotError('run_active');
    if(this.runs.size>=100)throw new PilotError('run_limit');
    const status:RunStatus & {execution:RunExecution}={id:randomUUID(),sessionId,provider,status:'running',elapsedMs:0,steps:0,trace:[],phase:'admission',metrics:{decisions:0,actions:0,reads:0,calls:0,timeMs:{}},execution:executionIdentity(options)};
    const run:Run={owner,profileId,status,controller:new AbortController(),call,started:performance.now()};this.runs.set(status.id,run);
    void this.loop(run,goal,options);return structuredClone(status);
  }
  status(owner:string,id:string){const r=this.owned(owner,id);return structuredClone({...r.status,elapsedMs:r.status.status==='running'?Math.round(performance.now()-r.started):r.status.elapsedMs});}
  active(profileId:string,sessionId:string){return [...this.runs.values()].some(r=>r.profileId===profileId&&r.status.sessionId===sessionId&&r.status.status==='running');}
  cancelSession(profileId:string,sessionId:string){for(const r of this.runs.values())if(r.profileId===profileId&&r.status.sessionId===sessionId)this.stop(r);}
  private owned(owner:string,id:string){const r=this.runs.get(id);if(!r||r.owner!==owner)throw new PilotError('run_not_owned');return r;}
  cancel(owner:string,id:string){const r=this.owned(owner,id);this.stop(r);return this.status(owner,id);}
  private stop(r:Run){if(r.status.status!=='running')return;r.controller.abort();r.status.status='cancelled';r.status.code='cancelled';void r.call('cancel').catch(()=>{});}
  cancelProfile(profileId:string){for(const r of this.runs.values())if(r.profileId===profileId)this.stop(r);}
  cancelOwner(owner:string){for(const r of this.runs.values())if(r.owner===owner)this.stop(r);}
  cancelAll(){for(const r of this.runs.values())this.stop(r);}
  private async loop(r:Run,goal:string,options:RunOptions){
    const check=()=>{if(r.controller.signal.aborted)throw new PilotError('cancelled');};
    const call=async(command:string,payload?:unknown)=>{
      check();
      const phase:RunPhase=command==='select'?'decision':command==='v2.plan'?'planning':command==='v2.state'||command==='v2.frames'?'observation':command==='v2.read'?'verification':command==='cancel'||command==='v2.handoff'?'recovery':command==='v2.commit'||command==='v2.credential'||command.startsWith('workflow.')?'dispatch':'admission';
      r.status.phase=phase;const started=performance.now(),metrics=r.status.metrics!;metrics.calls++;if(command==='select')metrics.decisions++;if(['v2.commit','v2.credential','workflow.upload','workflow.download'].includes(command))metrics.actions++;if(['v2.read','workflow.document'].includes(command))metrics.reads++;
      let abort!:()=>void;
      const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(new PilotError('cancelled'));r.controller.signal.addEventListener('abort',abort,{once:true});});
      try{const result=await Promise.race([r.call(command,payload),cancelled]);check();return result;}
      finally{r.controller.signal.removeEventListener('abort',abort);metrics.timeMs[phase]=(metrics.timeMs[phase]??0)+Math.round(performance.now()-started);}
    };
    let timedOut=false;const deadline=setTimeout(()=>{timedOut=true;r.controller.abort();void r.call('cancel').catch(()=>{});},options.timeoutMs);
    try{
      if(options.workflow){
        const nativeInput=!options.readonly&&options.workflow.nativeInput!==false;
        const capabilities=await call('v2.capabilities');
        if(nativeInput&&capabilities.capabilities.nativeInput.status!=='available')throw new PilotError('native_input_permission_required');
        if(options.workflow.visual){
          if(capabilities.capabilities.capture.status!=='available')throw new PilotError('capture_permission_required');
          const provider=options.workflow.visual.provider??r.status.provider;
          const configuration=(await call('status')).configs.find((config:any)=>config.provider===provider);
          if(!configuration?.model)throw new PilotError('missing_visual_model');
          if(imageDecisionCapability(configuration).status!=='available')throw new PilotError('provider_vision_unsupported');
        }
        await executeWorkflow(r.status,goal,{...options.workflow,nativeInput},options.readonly,options.maxSteps,call,this.redact);
      }else await executeWorkflow(r.status,goal,undefined,options.readonly,options.maxSteps,call,this.redact);
    }catch(error){if(r.status.status==='running'){r.status.status=timedOut?'failed':r.controller.signal.aborted?'cancelled':'failed';r.status.code=timedOut?'run_timeout':r.controller.signal.aborted?'cancelled':safeCode(error);}}
    finally{r.status.phase='terminal';clearTimeout(deadline);r.status.elapsedMs=Math.round(performance.now()-r.started);r.expires=setTimeout(()=>this.runs.delete(r.status.id),600000).unref();}
  }
}
