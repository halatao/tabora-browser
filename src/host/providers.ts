import {fork,spawn,type ChildProcess} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {PilotError,parseChoice,type DecisionRequest,type ProviderConfig,type DecisionResult} from '../shared.js';
import type {AdapterResult} from './adapters.js';
import {sdkEnvironment} from './sdk-environment.js';
type Worker={scope:string;signature:string;child:ChildProcess;directory:string;closed:Promise<void>;stopping?:Promise<void>;idle?:NodeJS.Timeout;busy:boolean;stopped:boolean};

/** Bounded workers; a scope is one profile/session, never shared conversation history. */
export class DecisionPool {
  private workers=new Map<string,Worker>();
  private pending=new Set<string>();
  private stopping=new Set<Promise<void>>();
  constructor(private stateDir:string,private options:{idleMs?:number;limit?:number;workerPath?:string}={}){}
  private async create(scope:string,signature:string,config:ProviderConfig){
    await mkdir(path.join(this.stateDir,'runs'),{recursive:true});
    const directory=await mkdtemp(path.join(this.stateDir,'runs','decision-'));
    const env:Record<string,string>={};
    for(const name of ['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP'])if(process.env[name])env[name]=process.env[name]!;
    if(config.connection==='sdk')Object.assign(env,sdkEnvironment());
    else Object.assign(env,{HOME:directory,USERPROFILE:directory,APPDATA:directory,LOCALAPPDATA:directory});
    const child=fork(this.options.workerPath??path.join(import.meta.dirname,'provider-worker.js'),[],{env,cwd:directory,stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,execArgv:[]});
    const worker:Worker={scope,signature,child,directory,closed:new Promise(resolve=>child.once('close',()=>resolve())),busy:false,stopped:false};
    child.on('error',()=>{});child.once('exit',()=>{if(this.workers.get(scope)===worker)this.workers.delete(scope);});
    return worker;
  }
  private stop(w:Worker):Promise<void>{
    if(w.stopping)return w.stopping;
    w.stopping=this.stopWorker(w);this.stopping.add(w.stopping);
    void w.stopping.then(()=>this.stopping.delete(w.stopping!),()=>this.stopping.delete(w.stopping!));return w.stopping;
  }
  private async stopWorker(w:Worker){
    w.stopped=true;clearTimeout(w.idle);
    if(this.workers.get(w.scope)===w)this.workers.delete(w.scope);
    if(w.child.connected)w.child.send({kind:'cancel'},()=>{});
    const kill=setTimeout(()=>{
      if(w.child.exitCode!==null)return;
      if(process.platform==='win32'&&w.child.pid)spawn('taskkill',['/PID',String(w.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('error',()=>w.child.kill());else w.child.kill();
    },1500).unref();
    await w.closed;clearTimeout(kill);
    if(path.dirname(path.resolve(w.directory))!==path.resolve(this.stateDir,'runs'))throw new Error('Invalid cleanup target');
    await rm(w.directory,{recursive:true,force:true,maxRetries:3});
  }
  invalidate(prefix=''){for(const w of this.workers.values())if(w.scope.startsWith(prefix))void this.stop(w).catch(()=>{});}
  async close(){await Promise.all([...this.workers.values()].map(w=>this.stop(w)).concat([...this.stopping]));}
  async decide(scope:string,config:ProviderConfig,request:DecisionRequest,key:string,signal:AbortSignal):Promise<DecisionResult>{
    const start=performance.now();let w:Worker|undefined,dispatchStarted=0;
    const runtime={coldStart:false,setupMs:0,dispatchMs:0,cleanupMs:0};
    const metadata=()=>({requestId:request.requestId,stateVersion:request.stateVersion,provider:config.provider,model:config.model,latencyMs:Math.round(performance.now()-start),runtime:{...runtime}});
    if(config.provider==='openai-decisions')return {...metadata(),status:'failed',code:'decisions_preview_unavailable'};
    if(!config.model)return {...metadata(),status:'failed',code:'missing_model'};
    if(signal.aborted)return {...metadata(),status:'failed',code:'cancelled'};
    if(this.pending.has(scope))return {...metadata(),status:'failed',code:'session_busy'};
    this.pending.add(scope);
    try{
      const signature=createHash('sha256').update(JSON.stringify(config)).update(key).digest('hex');
      w=this.workers.get(scope);
      if(w&&w.signature!==signature){await this.stop(w);w=undefined;}
      if(!w){if(this.workers.size+[...this.pending].filter(key=>!this.workers.has(key)).length>(this.options.limit??20))throw new PilotError('runtime_limit');runtime.coldStart=true;w=await this.create(scope,signature,config);this.workers.set(scope,w);}
      clearTimeout(w.idle);w.busy=true;
      const worker=w;
      runtime.setupMs=Math.round(performance.now()-start);dispatchStarted=performance.now();
      const result=await new Promise<AdapterResult>((resolve,reject)=>{
        const id=randomUUID();let complete=false;
        const finish=(error?:Error,data?:AdapterResult)=>{if(complete)return;complete=true;clearTimeout(timer);signal.removeEventListener('abort',abort);worker.child.off('message',message);worker.child.off('exit',exit);worker.child.off('error',errorHandler);if(error)reject(error);else resolve(data!);};
        const abort=()=>finish(new PilotError('cancelled')),exit=()=>finish(new PilotError(worker.stopped?'cancelled':'provider_failed')),errorHandler=()=>finish(new PilotError('provider_start_failed'));
        const message=(value:any)=>{if(value?.id!==id)return;if(!value.ok){finish(new PilotError(value.code??'provider_failed'));return;}try{parseChoice({choiceId:value.result?.choiceId},request);finish(undefined,value.result);}catch{finish(new PilotError('invalid_response'));}};
        const timer=setTimeout(()=>finish(new PilotError('timeout')),config.timeoutMs);
        worker.child.on('message',message);worker.child.once('exit',exit);worker.child.once('error',errorHandler);signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted||worker.stopped){abort();return;}
        worker.child.send({kind:'start',id,request,config,apiKey:key,directory:worker.directory},error=>{if(error)errorHandler();});
      });
      runtime.dispatchMs=Math.round(performance.now()-dispatchStarted);dispatchStarted=0;
      if(signal.aborted||w.stopped)throw new PilotError('cancelled');
      w.idle=setTimeout(()=>void this.stop(worker).catch(()=>{}),this.options.idleMs??60000).unref();
      return {...metadata(),...result,status:'selected',model:result.model??config.model};
    }catch(error){if(dispatchStarted)runtime.dispatchMs=Math.round(performance.now()-dispatchStarted);if(w){const cleanup=performance.now();await this.stop(w);runtime.cleanupMs=Math.round(performance.now()-cleanup);}return {...metadata(),status:'failed',code:error instanceof PilotError?error.code:'provider_failed'};}
    finally{if(w)w.busy=false;this.pending.delete(scope);}
  }
}
export async function decide(config:ProviderConfig,request:DecisionRequest,key:string,stateDir:string,signal:AbortSignal):Promise<DecisionResult>{
  const pool=new DecisionPool(stateDir),start=performance.now();
  try{const result=await pool.decide('one-shot',config,request,key,signal);await pool.close();return {...result,latencyMs:Math.round(performance.now()-start)};}finally{await pool.close();}
}
