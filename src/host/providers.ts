import { fork, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PilotError, parseChoice, type DecisionRequest, type ProviderConfig, type DecisionResult } from '../shared.js';
import type { AdapterResult } from './adapters.js';

export async function decide(config: ProviderConfig, request: DecisionRequest, key: string, stateDir: string, signal: AbortSignal): Promise<DecisionResult> {
  const start=performance.now();
  const metadata=()=>({requestId:request.requestId,stateVersion:request.stateVersion,provider:config.provider,model:config.model,latencyMs:Math.round(performance.now()-start)});
  if(config.provider==='openai-decisions') return {...metadata(),status:'failed',code:'decisions_preview_unavailable'};
  if(!config.model)return {...metadata(),status:'failed',code:'missing_model'};
  if(signal.aborted)return {...metadata(),status:'failed',code:'cancelled'};
  await mkdir(path.join(stateDir,'runs'),{recursive:true});
  const directory=await mkdtemp(path.join(stateDir,'runs','decision-'));
  let closed:Promise<void>=Promise.resolve();
  try {
    const result=await new Promise<AdapterResult>((resolve,reject)=>{
      // Only runtime essentials are inherited, never the host's environment secrets.
      const env:Record<string,string>={};
      for(const name of ['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP']) if(process.env[name])env[name]=process.env[name]!;
      Object.assign(env,{HOME:directory,USERPROFILE:directory,APPDATA:directory,LOCALAPPDATA:directory});
      const child=fork(path.join(import.meta.dirname,'provider-worker.js'),[],{env,cwd:directory,stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,execArgv:[]});
      closed=new Promise(resolve=>child.once('close',()=>resolve()));
      let complete=false, termination:NodeJS.Timeout|undefined;
      const finish=(error?:Error,data?:AdapterResult)=>{
        if(complete)return; complete=true;clearTimeout(timer);signal.removeEventListener('abort',abort);
        if(error){if(child.connected)child.send({kind:'cancel'});reject(error);}else resolve(data!);
        termination=setTimeout(()=>{
          if(child.exitCode!==null)return;
          if(process.platform==='win32'&&child.pid)spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('error',()=>child.kill());
          else child.kill();
        },1500).unref();
      };
      const abort=()=>finish(new PilotError('cancelled'));
      const timer=setTimeout(()=>finish(new PilotError('timeout')),config.timeoutMs);
      signal.addEventListener('abort',abort,{once:true});
      child.on('error',()=>finish(new PilotError('provider_start_failed')));
      child.on('exit',()=>{clearTimeout(termination);if(!complete)finish(new PilotError('provider_failed'));});
      child.on('message',(message:any)=>{
        if(message?.ok) {try {parseChoice({choiceId:message.result?.choiceId},request);}catch{finish(new PilotError('invalid_response'));return;}}
        if(message?.ok)finish(undefined,message.result);else finish(new PilotError(typeof message?.code==='string'?message.code:'provider_failed'));
      });
      child.send({kind:'start',request,config,apiKey:key,directory});
    });
    return {...metadata(),...result,status:'selected',model:result.model??config.model};
  } catch(error) {return {...metadata(),status:'failed',code:error instanceof PilotError?error.code:'provider_failed'};}
  finally {
    await closed;
    if(path.dirname(path.resolve(directory))!==path.resolve(stateDir,'runs'))throw new Error('Invalid cleanup target');
    await rm(directory,{recursive:true,force:true,maxRetries:3}).catch(()=>{});
  }
}
