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
    let finished=false,probing=false;
    const finish=(error?:Error)=>{if(finished)return;finished=true;clearTimeout(timer);clearInterval(poll);chrome.tabs.onUpdated.removeListener(updated);chrome.tabs.onRemoved.removeListener(removed);if(error)reject(error);else resolve();};
    const check=async(tab:chrome.tabs.Tab)=>{
      if(finished||tab.pendingUrl&&tab.pendingUrl!==tab.url)return;
      if(!/^https?:/.test(tab.url??'')){if(!requireHttp&&tab.status==='complete')finish();return;}
      if(probing)return;
      probing=true;
      try{
        // DOM readiness is enough to bind. Slow images/analytics must not hold
        // a usable document hostage; script injection still requires a grant.
        const [result]=await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',func:()=>({ready:!!document.body&&(document.readyState==='complete'||((performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming|undefined)?.domContentLoadedEventEnd??0)>0),href:location.href})});
        if(result?.result?.ready&&result.result.href===tab.url&&!finished){const live=await chrome.tabs.get(tabId);if(live.url===tab.url&&(!live.pendingUrl||live.pendingUrl===live.url))finish();}
      }catch{/* A denied, missing or still navigating document is not ready. */}
      finally{probing=false;}
    };
    const probe=()=>void chrome.tabs.get(tabId).then(check,()=>finish(new PilotError('tab_closed')));
    const updated=(id:number)=>{if(id===tabId)probe();};
    const removed=(id:number)=>{if(id===tabId)finish(new PilotError('tab_closed'));};
    const timer=setTimeout(()=>finish(new PilotError('readiness_timeout')),timeoutMs);
    const poll=setInterval(probe,100);
    chrome.tabs.onUpdated.addListener(updated);chrome.tabs.onRemoved.addListener(removed);
    probe();
  });
}
