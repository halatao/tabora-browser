import {PilotError} from '../shared.js';
import {withTargetDebugger} from './target-debugger.js';
// One interaction per extension/profile, including readiness and fresh observation.
// CDP focus emulation is scoped to the owned tab; desktop focus is never changed.
let interactionQueue:Promise<void>=Promise.resolve();
export async function withInteractiveTab<T>(tabId:number,validate:()=>Promise<void>,action:()=>Promise<T>,timeoutMs=15000,paintRequired=false):Promise<T>{
  const queuedAt=performance.now(),previous=interactionQueue;let release!:()=>void;
  const lease=new Promise<void>(resolve=>{release=resolve;});
  interactionQueue=previous.then(()=>lease);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    await Promise.race([previous,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new PilotError('interaction_busy',undefined,{blockers:[],phase:'queue',dispatch:'not_sent',deadlineMs:timeoutMs,nextStep:'retry_read'})),timeoutMs);})]);
    clearTimeout(timer);await validate();
    const tab=await chrome.tabs.get(tabId).catch(()=>{throw new PilotError('tab_closed');});
    const window=await chrome.windows.get(tab.windowId);
    const tabState={active:tab.active,discarded:tab.discarded,frozen:(tab as chrome.tabs.Tab&{frozen?:boolean}).frozen,windowState:window.state,windowFocused:window.focused};
    if(tab.discarded||tabState.frozen)throw new PilotError(tab.discarded?'tab_discarded':'tab_frozen',undefined,{blockers:[],phase:'lifecycle',cause:tab.discarded?'discarded':'frozen',dispatch:'not_sent',nextStep:'handoff',tab:tabState});
    await validate();
    const started=performance.now();let protectedTab=false,result:T|undefined;
    try{
      if(tab.autoDiscardable===true){await chrome.tabs.update(tabId,{autoDiscardable:false});protectedTab=true;await validate();}
      result=await withTargetDebugger(tabId,validate,()=>action(),false,paintRequired);
      if(result&&typeof result==='object')Object.assign(result,{interaction:{totalMs:Math.round(performance.now()-started),queueMs:Math.round(started-queuedAt),tab:tabState}});
      return result;
    }catch(error){
      if(error instanceof PilotError&&/^(background_|target_|modal_blocked)/.test(error.code))error.details={blockers:[],phase:/attach|debugger/.test(error.code)?'attach':error.code.startsWith('background_')?'render':'actionability',dispatch:'not_sent',tab:tabState,...error.details};
      throw error;
    }finally{
      if(protectedTab){
        const live=await chrome.tabs.get(tabId).catch(()=>undefined);
        if(live?.autoDiscardable===false)try{await chrome.tabs.update(tabId,{autoDiscardable:true});}
        catch{if(result&&typeof result==='object')Object.assign(result,{backgroundWarning:{code:'background_discard_restore_failed',nextStep:'inspect_tab_policy'}});}
      }
    }
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
