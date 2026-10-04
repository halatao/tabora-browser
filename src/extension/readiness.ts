import {PilotError} from '../shared.js';
import {withTargetDebugger} from './target-debugger.js';
// One interaction per extension/profile, including readiness and fresh observation.
// CDP focus emulation is scoped to the owned tab; desktop focus is never changed.
let interactionQueue:Promise<void>=Promise.resolve();
export async function withInteractiveTab<T>(tabId:number,validate:()=>Promise<void>,action:()=>Promise<T>,timeoutMs=15000):Promise<T>{
  const previous=interactionQueue;let release!:()=>void;
  const lease=new Promise<void>(resolve=>{release=resolve;});
  interactionQueue=previous.then(()=>lease);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    await Promise.race([previous,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new PilotError('interaction_busy')),timeoutMs);})]);
    clearTimeout(timer);await validate();
    await chrome.tabs.get(tabId);
    await validate();
    return await withTargetDebugger(tabId,validate,()=>action(),false);
  }finally{clearTimeout(timer);release();}
}
/** Subscribe before checking state; loading/complete transitions cannot fall in a gap. */
export function waitForTab(tabId:number,timeoutMs=10000,requireHttp=false):Promise<void>{
  return new Promise((resolve,reject)=>{
    const finish=(error?:Error)=>{clearTimeout(timer);chrome.tabs.onUpdated.removeListener(updated);chrome.tabs.onRemoved.removeListener(removed);if(error)reject(error);else resolve();};
    const check=(tab:chrome.tabs.Tab)=>{if(tab.status==='complete'&&(!requireHttp||/^https?:/.test(tab.url??'')))finish();};
    const updated=(id:number,change:chrome.tabs.OnUpdatedInfo)=>{if(id!==tabId)return;if(requireHttp)void chrome.tabs.get(tabId).then(check,()=>finish(new PilotError('tab_closed')));else if(change.status==='complete')finish();};
    const removed=(id:number)=>{if(id===tabId)finish(new PilotError('tab_closed'));};
    const timer=setTimeout(()=>finish(new PilotError('readiness_timeout')),timeoutMs);
    chrome.tabs.onUpdated.addListener(updated);chrome.tabs.onRemoved.addListener(removed);
    void chrome.tabs.get(tabId).then(check,()=>finish(new PilotError('tab_closed')));
  });
}
