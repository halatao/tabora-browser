import {PilotError} from '../shared.js';

type Lease={target:chrome.debugger.Debuggee;alive:boolean;dialogBlocked?:boolean};
const leases=new Map<number,Lease>();
export function markDialogBlocked(tabId:number){const lease=leases.get(tabId);if(lease)lease.dialogBlocked=true;}

/** A private, tab-scoped CDP lease. Nested input/capture reuse it; other debuggers are never detached. */
export async function withTargetDebugger<T>(tabId:number,validate:()=>Promise<void>,action:(target:chrome.debugger.Debuggee|undefined)=>Promise<T>,required=true):Promise<T>{
  await validate();
  if(!await chrome.permissions.contains({permissions:['debugger']})){
    if(required)throw new PilotError('native_input_permission_required');
    return action(undefined);
  }
  const existing=leases.get(tabId);
  if(existing){if(!existing.alive)throw new PilotError('background_interrupted');return action(existing.target);}
  const lease:Lease={target:{tabId},alive:false};let attached=false,rendering=false;
  const detached=(source:chrome.debugger.Debuggee)=>{if(source.tabId===tabId&&!(source as any).sessionId)lease.alive=false;};
  // A 1-pixel rendering stream keeps the hidden compositor producing frames.
  // Ignore its image bytes: they never enter artifacts, logs, host messages or provider input.
  const frame=(source:chrome.debugger.Debuggee,method:string,params?:any)=>{
    if(source.tabId===tabId&&!(source as any).sessionId&&method==='Page.screencastFrame'&&lease.alive&&Number.isSafeInteger(params?.sessionId))void chrome.debugger.sendCommand(lease.target,'Page.screencastFrameAck',{sessionId:params.sessionId}).catch(()=>{});
  };
  try{
    try{await chrome.debugger.attach(lease.target,'1.3');attached=true;lease.alive=true;}
    catch{throw new PilotError('background_debugger_unavailable');}
    chrome.debugger.onDetach.addListener(detached);
    leases.set(tabId,lease);
    // Enable before DOM preparation: hidden pages otherwise suspend requestAnimationFrame.
    // This changes the target renderer's focus/visibility, never the user's active tab/window.
    try{await chrome.debugger.sendCommand(lease.target,'Emulation.setFocusEmulationEnabled',{enabled:true});}
    catch{throw new PilotError('background_emulation_unavailable');}
    chrome.debugger.onEvent.addListener(frame);
    try{
      await chrome.debugger.sendCommand(lease.target,'Page.enable');
      await chrome.debugger.sendCommand(lease.target,'Page.startScreencast',{format:'jpeg',quality:0,maxWidth:1,maxHeight:1,everyNthFrame:1});rendering=true;
    }catch{throw new PilotError('background_rendering_unavailable');}
    if(!lease.alive)throw new PilotError('background_interrupted');
    await validate();return await action(lease.target);
  }finally{
    let cleanupFailed=false;
    if(attached&&lease.alive){
      if(rendering&&!lease.dialogBlocked)await chrome.debugger.sendCommand(lease.target,'Page.stopScreencast').catch(()=>{});
      if(!lease.dialogBlocked)await chrome.debugger.sendCommand(lease.target,'Emulation.setFocusEmulationEnabled',{enabled:false}).catch(()=>{});
      if(lease.alive)try{await chrome.debugger.detach(lease.target);}catch{cleanupFailed=lease.alive;}
    }
    leases.delete(tabId);chrome.debugger.onDetach.removeListener(detached);chrome.debugger.onEvent.removeListener(frame);
    if(cleanupFailed)throw new PilotError('background_cleanup_failed');
  }
}
