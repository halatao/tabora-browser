import {PilotError} from '../shared.js';

type Lease={target:chrome.debugger.Debuggee;alive:boolean;ready:boolean;rendered:boolean;dialogBlocked?:boolean};
const leases=new Map<number,Lease>();
export function markDialogBlocked(tabId:number){const lease=leases.get(tabId);if(lease)lease.dialogBlocked=true;}
async function deadline<T>(operation:Promise<T>,code:string,ms=3000){
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new PilotError(code)),ms);})]);}
  finally{clearTimeout(timer);}
}

/** Nested input/capture reuse this tab's lease; a competing debugger is never detached. */
export async function withTargetDebugger<T>(tabId:number,validate:()=>Promise<void>,action:(target:chrome.debugger.Debuggee|undefined)=>Promise<T>,required=true,paintRequired=true):Promise<T>{
  await validate();
  if(!await chrome.permissions.contains({permissions:['debugger']})){
    if(required)throw new PilotError('native_input_permission_required');
    return action(undefined);
  }
  const existing=leases.get(tabId);
  if(existing){if(!existing.alive||!existing.ready)throw new PilotError('background_interrupted');if(paintRequired&&!existing.rendered)throw new PilotError('background_render_timeout',undefined,{blockers:[],phase:'render',cause:'render_timeout',dispatch:'not_sent',nextStep:'observe'});await validate();return action(existing.target);}
  const lease:Lease={target:{tabId},alive:false,ready:false,rendered:false};
  leases.set(tabId,lease);
  let attached=false,attachPending=true,expired=false,rendering=false,cleanupFailed=false;
  const started=performance.now();let acquiredAt=started,renderedAt=started,actionFinished=started;
  let firstFrame!:()=>void;const rendered=new Promise<void>(resolve=>{firstFrame=resolve;});
  const detached=(source:chrome.debugger.Debuggee)=>{if(source.tabId===tabId&&!(source as any).sessionId){lease.alive=false;if(expired){if(leases.get(tabId)===lease)leases.delete(tabId);chrome.debugger.onDetach.removeListener(detached);}}};
  // Frame bytes stay in this listener and never enter artifacts or model input.
  const frame=(source:chrome.debugger.Debuggee,method:string,params?:any)=>{
    if(source.tabId===tabId&&!(source as any).sessionId&&method==='Page.screencastFrame'&&lease.alive&&Number.isSafeInteger(params?.sessionId)){
      firstFrame();void chrome.debugger.sendCommand(lease.target,'Page.screencastFrameAck',{sessionId:params.sessionId}).catch(()=>{});
    }
  };
  const command=(method:string,params?:Record<string,unknown>)=>deadline(chrome.debugger.sendCommand(lease.target,method,params),'background_command_timeout');
  const attach=chrome.debugger.attach(lease.target,'1.3').then(async()=>{
    attachPending=false;attached=true;lease.alive=true;
    if(expired){
      try{await deadline(chrome.debugger.detach(lease.target),'background_cleanup_timeout');lease.alive=false;if(leases.get(tabId)===lease)leases.delete(tabId);}
      catch{chrome.debugger.onDetach.addListener(detached);}
    }
  },error=>{attachPending=false;if(expired&&leases.get(tabId)===lease)leases.delete(tabId);throw error;});
  let result:T|undefined,failed=false;
  try{
    try{await deadline(attach,'background_attach_timeout');}
    catch(error){expired=true;throw error instanceof PilotError?error:new PilotError('background_debugger_unavailable');}
    acquiredAt=performance.now();chrome.debugger.onDetach.addListener(detached);chrome.debugger.onEvent.addListener(frame);
    try{await command('Emulation.setFocusEmulationEnabled',{enabled:true});}
    catch{throw new PilotError('background_emulation_unavailable');}
    try{
      await command('Page.enable');
      await command('Page.startScreencast',{format:'jpeg',quality:0,maxWidth:1,maxHeight:1,everyNthFrame:1});rendering=true;
      const probe=chrome.scripting?.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',func:(timeoutMs:number)=>new Promise<{ready:boolean;visibility:DocumentVisibilityState;hasFocus:boolean}>(resolve=>{
        let frame=0,done=false;
        const finish=(ready:boolean)=>{if(done)return;done=true;clearTimeout(timer);cancelAnimationFrame(frame);resolve({ready,visibility:document.visibilityState,hasFocus:document.hasFocus()});};
        const timer=setTimeout(()=>finish(false),timeoutMs);
        frame=requestAnimationFrame(()=>{frame=requestAnimationFrame(()=>finish(true));});
      }),args:[paintRequired?1200:150]}).then(results=>{const observed=results[0]?.result;lease.rendered=observed?.ready===true;if(paintRequired&&!lease.rendered)throw new PilotError('background_render_timeout',undefined,{blockers:[],cause:'render_timeout',phase:'render',dispatch:'not_sent',nextStep:'retry_read',document:observed?{visibility:observed.visibility,hasFocus:observed.hasFocus}:undefined});});
      // The first screencast event can contain a cached frame. With a live
      // document, require newly executed animation callbacks before proceeding.
      await deadline(probe??rendered.then(()=>{lease.rendered=true;}),'background_render_timeout',1500);
    }catch(error){throw error instanceof PilotError?error:new PilotError('background_rendering_unavailable');}
    if(!lease.alive)throw new PilotError('background_interrupted');
    renderedAt=performance.now();await validate();lease.ready=true;result=await action(lease.target);actionFinished=performance.now();
  }catch(error){failed=true;throw error;}
  finally{
    expired=true;lease.ready=false;
    if(attached&&lease.alive){
      if(!lease.dialogBlocked){
        if(rendering)await command('Page.stopScreencast').catch(()=>{cleanupFailed=true;});
        await command('Emulation.setFocusEmulationEnabled',{enabled:false}).catch(()=>{cleanupFailed=true;});
      }
      if(lease.alive)await deadline(chrome.debugger.detach(lease.target).then(()=>{lease.alive=false;}),'background_cleanup_timeout').catch(()=>{cleanupFailed=true;});
    }
    // A timed-out attach owns a quarantine until its late completion detaches it.
    if(!attachPending&&!lease.alive&&leases.get(tabId)===lease)leases.delete(tabId);
    if(!lease.alive)chrome.debugger.onDetach.removeListener(detached);chrome.debugger.onEvent.removeListener(frame);
    if(!failed&&result&&typeof result==='object')Object.assign(result,{backgroundTimings:{attachMs:Math.round(acquiredAt-started),renderMs:Math.round(renderedAt-acquiredAt),operationMs:Math.round(actionFinished-renderedAt),cleanupMs:Math.round(performance.now()-actionFinished)}});
    if(!failed&&result&&typeof result==='object')Object.assign(result,{backgroundReadiness:{rendered:lease.rendered,geometry:'live_dom'}});
    if(cleanupFailed&&!failed&&result&&typeof result==='object')Object.assign(result,{backgroundWarning:{code:'background_cleanup_failed',nextStep:'verify_outcome'}});
  }
  return result as T;
}
