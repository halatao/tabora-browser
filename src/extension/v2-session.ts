import {z} from 'zod';
import {actionSchema,outcomePredicate,dialogSchema,type ExpectedDialog,type OutcomePredicate,type BrowserAction,type ObservationV2,type TargetV2} from '../capabilities.js';
import {PilotError,exactOrigin,type Binding,type BrowserProfile} from '../shared.js';
import {enforceRecipe} from './policy.js';
import {withInteractiveTab,waitForTab} from './readiness.js';
import {nativeInput} from './input-backend.js';
import {captureRegion} from './capture.js';
import {downloadLink} from './download.js';
import {imageSize} from '../image-size.js';

export function createCapabilitySession(id:string,getBinding:()=>Binding|undefined,getPolicy:()=>Pick<BrowserProfile,'mode'|'vaultEnabled'>,validateTab:(tabId:number)=>Promise<void>,getGeneration:()=>number,allowedOrigins:()=>string[],rebind:(tabId:number)=>Promise<Binding>,siteToolsEnabled:()=>boolean){
  const loaded=new Set<string>(),snapshots=new Map<string,{frameId:number;documentId:string;origin:string;snapshotId:string;documentToken:string;targets:TargetV2[]}>();
  const loadedTokens=new Map<string,string>();
  let pending:{id:string;stateVersion:string;frameId:number;action:BrowserAction;expires:number;expect?:OutcomePredicate;timeoutMs:number;dialog?:ExpectedDialog;visual?:{point:{x:number;y:number};rect:string}}|undefined;
  let capture:{id:string;data:string;expires:number}|undefined;
  let visualGrant:{id:string;targetId:string;documentId:string;snapshotId:string;width:number;height:number;region:any;expires:number}|undefined;
  let handoff:{tabId:number;origin:string;reason:string}|undefined;
  let humanProgress:{reason:string;origin:string;tabId:number}|undefined;
  function dispose(){const b=getBinding();if(!b)return;for(const [documentId,documentToken] of loadedTokens){
    void chrome.scripting.executeScript({target:{tabId:b.tabId,documentIds:[documentId]},world:'ISOLATED',func:async(sessionId,documentToken)=>{const operation=(globalThis as any).__taboraOperation;if(operation)await operation({op:'cancel',sessionId,documentToken,origin:location.origin});},args:[id,documentToken]}).catch(()=>{});
    }
    loadedTokens.clear();
  }
  const binding=()=>{const b=getBinding();if(!b)throw new PilotError('no_bound_tab');return {...b};};
  async function frames(){
    const b=binding(),run=getGeneration();await validateTab(b.tabId);
    const all=await chrome.webNavigation.getAllFrames({tabId:b.tabId});if(run!==getGeneration())throw new PilotError('cancelled');
    return Promise.all((all??[]).slice(0,64).map(async frame=>{
      let origin:string|undefined;try{origin=exactOrigin(frame.url);}catch{}
      const inTask=origin===b.origin||!!origin&&allowedOrigins().includes(origin),permitted=!!origin&&inTask&&await chrome.permissions.contains({origins:[origin+'/*']});
      return {frameId:frame.frameId,documentId:frame.documentId,parentFrameId:frame.parentFrameId,origin,allowed:permitted,reason:permitted?undefined:inTask?'site_permission_required':'frame_origin_not_granted'};
    }));
  }
  async function liveFrame(frameId=0){
    const b=binding(),frame=(await frames()).find(f=>f.frameId===frameId);
    if(!frame?.allowed||!frame.origin)throw new PilotError('frame_not_permitted');
    if(frameId===0&&frame.documentId!==b.documentId)throw new PilotError('stale_binding');
    return {...frame,origin:frame.origin,tabId:b.tabId};
  }
  async function sensor(frameId:number,input:Record<string,unknown>){
    const run=getGeneration(),frame=await liveFrame(frameId),target={tabId:frame.tabId,documentIds:[frame.documentId]};
    if(!loaded.has(frame.documentId)){
      await chrome.scripting.executeScript({target,world:'ISOLATED',files:['sensor.js']});loaded.add(frame.documentId);
      if(loaded.size>64)loaded.delete(loaded.values().next().value!);
    }
    if(run!==getGeneration())throw new PilotError('cancelled');
    const result=await chrome.scripting.executeScript({target,world:'ISOLATED',func:async input=>{
      const operation=(globalThis as any).__taboraOperation;
      if(!operation)return {ok:false,code:'sensor_unavailable'};return operation(input);
    },args:[{...input,origin:frame.origin,sessionId:id,allowedOrigins:[binding().origin,...allowedOrigins()]}]});
    if(run!==getGeneration())throw new PilotError('cancelled');
    const data=result[0]?.result;if(!data?.ok)throw new PilotError(data?.code??'execution_failed');const token=data.snapshot?.provenance?.documentToken??data.documentToken??data.provenance?.documentToken;if(typeof token==='string'){loadedTokens.set(frame.documentId,token);if(loadedTokens.size>64)loadedTokens.delete(loadedTokens.keys().next().value!);}return data;
  }
  async function state(input:{frameId:number;cursor:number;limit:number;baseSnapshotId?:string}){
    const frame=await liveFrame(input.frameId),result=await sensor(input.frameId,{op:'observe',...input});
    const snapshot=result.snapshot as ObservationV2;
    // Keep the full latest target set locally even when a caller requests a delta.
    if(result.fullSnapshot){
      const old=snapshots.get(String(input.frameId));if(result.continuationOf&&old?.snapshotId!==result.continuationOf)throw new PilotError('stale_continuation');
      snapshots.set(String(input.frameId),{...frame,snapshotId:snapshot.snapshotId,documentToken:snapshot.provenance.documentToken,targets:result.continuationOf?[...old!.targets,...snapshot.targets]:snapshot.targets});
    }
    else{
      const old=snapshots.get(String(input.frameId));if(!old||old.snapshotId!==input.baseSnapshotId)return state({...input,baseSnapshotId:undefined});
      const delta=result.snapshot,map=new Map(old.targets.map(t=>[t.id,t]));delta.removed.forEach((id:string)=>map.delete(id));[...delta.added,...delta.changed].forEach((t:TargetV2)=>map.set(t.id,t));
      snapshots.set(String(input.frameId),{...frame,snapshotId:snapshot.snapshotId,documentToken:snapshot.provenance.documentToken,targets:[...map.values()]});
    }
    return {...result,humanProgress:humanProgress?.tabId===frame.tabId&&humanProgress.origin===frame.origin?{status:'control_returned',reason:humanProgress.reason}:undefined,binding:{tabId:frame.tabId,documentId:frame.documentId,frameId:frame.frameId,origin:frame.origin},stateVersion:frame.documentId+':'+snapshot.snapshotId};
  }
  async function rootPoint(frameId:number,point:{x:number;y:number}){
    const all=await frames();let current=all.find(frame=>frame.frameId===frameId),result={...point};
    for(let depth=0;current&&current.frameId!==0&&depth<16;depth++){
      const parent=all.find(frame=>frame.frameId===current!.parentFrameId);if(!parent?.allowed)throw new PilotError('frame_not_permitted');
      const nonce=crypto.randomUUID();await sensor(parent.frameId,{op:'frame_arm',nonce});await sensor(current.frameId,{op:'frame_send',nonce});
      // postMessage delivery occurs after the child operation's script task.
      const {geometry}=await sensor(parent.frameId,{op:'frame_geometry',nonce});
      if(result.x<0||result.x>geometry.width||result.y<0||result.y>geometry.height)throw new PilotError('target_obscured');
      result={x:geometry.x+result.x*geometry.sx,y:geometry.y+result.y*geometry.sy};current=parent;
    }
    if(current?.frameId!==0)throw new PilotError('frame_limit');return result;
  }
  async function command(name:string,input:any){
    if(name==='site_tools'||name==='site_call'){
      if(!siteToolsEnabled())return {status:'unsupported',reason:'webmcp_not_enabled',tools:[]};
      enforceRecipe(getPolicy(),name==='site_tools'?'extract':'fill');if(handoff&&name==='site_call')throw new PilotError('needs_user');
      const frame=await liveFrame(input.frameId??0);
      if(name==='site_call'&&input.documentId!==frame.documentId)throw new PilotError('stale_binding');
      return {documentId:frame.documentId,...await sensor(frame.frameId,{op:name==='site_tools'?'site_discover':'site_call',toolRef:input.toolRef,arguments:input.arguments})};
    }
    if(name==='download'){
      enforceRecipe(getPolicy(),'extract');const current=snapshots.get('0'),b=binding(),run=getGeneration();if(!current||input.stateVersion!==b.documentId+':'+current.snapshotId)throw new PilotError('stale_snapshot');
      const {url}=await sensor(0,{op:'download_target',targetId:input.targetId,snapshotId:current.snapshotId});
      return downloadLink(url,id,input.name,async()=>{enforceRecipe(getPolicy(),'extract');await validateTab(b.tabId);if(run!==getGeneration())throw new PilotError('cancelled');await liveFrame(0);},[b.origin,...allowedOrigins()],input.timeoutMs);
    }
    if(name==='handoff'){const b=binding();pending=undefined;capture=undefined;humanProgress=undefined;handoff={tabId:b.tabId,origin:b.origin,reason:input.reason};return {status:'needs_user',reason:input.reason,tabId:b.tabId};}
    if(name==='resume'){
      if(!handoff)throw new PilotError('no_handoff');const tab=await chrome.tabs.get(handoff.tabId),origin=exactOrigin(tab.url??'');
      if(origin!==handoff.origin&&!allowedOrigins().includes(origin))throw new PilotError('navigation_out_of_scope');await validateTab(handoff.tabId);await rebind(handoff.tabId);snapshots.clear();loaded.clear();humanProgress={...handoff,origin};handoff=undefined;return {status:'resumed',...await state({frameId:0,cursor:0,limit:60})};
    }
    if(handoff&&['plan','commit'].includes(name))throw new PilotError('needs_user');
    if(name==='capture_chunk'){enforceRecipe(getPolicy(),'extract');if(!capture||capture.id!==input.captureId||capture.expires<Date.now())throw new PilotError('capture_expired');const offset=z.number().int().min(0).max(capture.data.length).parse(input.offset);if(offset%4)throw new PilotError('invalid_file_chunk');const data=capture.data.slice(offset,offset+65536);return {data,nextOffset:offset+data.length,eof:offset+data.length===capture.data.length};}
    if(name==='capture_release'){capture=undefined;return {released:true};}
    if(name==='capture'){
      enforceRecipe(getPolicy(),'extract');const current=snapshots.get('0'),b=binding(),run=getGeneration();if(!current||input.stateVersion!==b.documentId+':'+current.snapshotId)throw new PilotError('stale_snapshot');
      if(!current.targets.some(target=>target.id===input.targetId)||(input.redactTargets??[]).some((id:string)=>!current.targets.some(target=>target.id===id)))throw new PilotError('unobserved_target');
      if(!await chrome.permissions.contains({permissions:['debugger']}))throw new PilotError('native_input_permission_required');
      return withInteractiveTab(b.tabId,async()=>{await validateTab(b.tabId);if(run!==getGeneration())throw new PilotError('cancelled');},async()=>{
        try{
          const region=await sensor(0,{op:'capture_mask',snapshotId:current.snapshotId,targetId:input.targetId,redactTargets:input.redactTargets});
          const data=await captureRegion(b.tabId,region.clip,async()=>{await validateTab(b.tabId);if(run!==getGeneration())throw new PilotError('cancelled');await liveFrame(0);await sensor(0,{op:'capture_validate'});});
          const header=atob(data.slice(0,44)),size=imageSize(Uint8Array.from(header,character=>character.charCodeAt(0)));
          capture={id:crypto.randomUUID(),data,expires:Date.now()+60000};visualGrant={id:capture.id,targetId:input.targetId,documentId:b.documentId,snapshotId:current.snapshotId,...size,region,expires:capture.expires};
          return {captureId:capture.id,base64Length:data.length,visual:{captureId:capture.id,...size,expiresAt:capture.expires},provenance:region.provenance,pixelRedaction:region.pixelRedaction,redactedRegions:region.redactedRegions};
        }finally{await sensor(0,{op:'capture_clear'}).catch(()=>{});}
      });
    }
    if(name==='capabilities'){const extended=await chrome.permissions.contains({permissions:['debugger']});return {schemaVersion:2,capabilities:{semantic:{status:'available'},shadow:{status:'available'},frames:{status:'available'},reader:{status:'available'},controls:{status:'available'},delta:{status:'available'},nativeInput:{status:extended?'available':'permission_required'},capture:{status:extended?'available':'permission_required'},vision:{status:'unsupported',reason:'decision_adapters_text_only'},webmcp:{status:siteToolsEnabled()?'experimental':'unsupported',reason:siteToolsEnabled()?'native_runtime_discovery_required':'webmcp_not_enabled'}}};}
    if(name==='frames')return {schemaVersion:2,frames:await frames()};
    if(name==='state'){enforceRecipe(getPolicy(),'extract');return state(input);}
    if(name==='read'){enforceRecipe(getPolicy(),'extract');return sensor(input.frameId,{op:'read',read:input});}
    if(name==='plan'){
      const action=actionSchema.parse(input.action);enforceRecipe(getPolicy(),['scroll','navigate'].includes(action.type)?'extract':'fill');const current=snapshots.get(String(input.frameId)),frame=await liveFrame(input.frameId);
      if(!current||current.documentId!==frame.documentId||input.stateVersion!==frame.documentId+':'+current.snapshotId)throw new PilotError('stale_snapshot');
      if(!current.targets.some(t=>t.id===action.targetId))throw new PilotError('unobserved_target');
      const target=current.targets.find(t=>t.id===action.targetId)!;if(['fill','key','replace','check','select'].includes(action.type)&&target.secret)throw new PilotError('sensitive_or_unsupported_field');
      if(action.type==='drag'&&!current.targets.some(t=>t.id===action.destinationId))throw new PilotError('unobserved_target');
      let visual:{point:{x:number;y:number};rect:string}|undefined;
      if(action.type==='image_click'){
        const grant=visualGrant;if(input.frameId!==0||!grant||grant.id!==action.captureId||grant.expires<Date.now()||grant.documentId!==frame.documentId||grant.snapshotId!==current.snapshotId||grant.targetId!==action.targetId||action.x>=grant.width||action.y>=grant.height)throw new PilotError('stale_capture');
        visual={point:{x:grant.region.viewport.x+action.x*grant.region.clip.width/grant.width,y:grant.region.viewport.y+action.y*grant.region.clip.height/grant.height},rect:grant.region.targetRect};
      }
      const expect=input.expect?outcomePredicate.parse(input.expect):undefined;
      if(expect&&expect.type!=='url'&&!current.targets.some(t=>t.id===expect.targetId))throw new PilotError('unobserved_target');
      const dialog=input.dialog?dialogSchema.parse(input.dialog):undefined;if(dialog&&(action.type!=='click'||action.backend!=='native'))throw new PilotError('invalid_request');
      pending={id:crypto.randomUUID(),frameId:input.frameId,stateVersion:input.stateVersion,action,expires:Date.now()+60000,expect,timeoutMs:input.timeoutMs??3000,dialog,visual};return {actionId:pending.id,stateVersion:pending.stateVersion,action};
    }
    if(name==='commit'){
      const plan=pending;pending=undefined;
      if(!plan||plan.id!==input.actionId||plan.expires<Date.now()||input.stateVersion!==plan.stateVersion)throw new PilotError('decision_expired');
      const recipe=['scroll','navigate'].includes(plan.action.type)?'extract':'fill';enforceRecipe(getPolicy(),recipe);
      const current=snapshots.get(String(plan.frameId));if(!current||plan.stateVersion!==current.documentId+':'+current.snapshotId)throw new PilotError('stale_snapshot');
      const b=binding(),run=getGeneration();
      return withInteractiveTab(b.tabId,async()=>{enforceRecipe(getPolicy(),recipe);await validateTab(b.tabId);if(run!==getGeneration())throw new PilotError('cancelled');},async()=>{
        const start=performance.now();let result:any,nativePrepareMs=0,inputMs=0;
        const native=['click','fill'].includes(plan.action.type)&&(plan.action as any).backend==='native'||['image_click','key','hover','drag'].includes(plan.action.type)||plan.action.type==='check'&&current.targets.find(t=>t.id===plan.action.targetId)?.inputType===undefined;
        if(native){
          if(!await chrome.permissions.contains({permissions:['debugger']}))throw new PilotError('native_input_permission_required');
          const preparing=performance.now(),prepared=await sensor(plan.frameId,{op:'native_prepare',snapshotId:current.snapshotId,action:plan.action,visual:plan.visual});nativePrepareMs=performance.now()-preparing;
          if(prepared.dispatch==='not_needed')result=prepared;
          else{
            const point=await rootPoint(plan.frameId,prepared.point),destination=prepared.destination?await rootPoint(plan.frameId,prepared.destination):undefined;
            const dispatching=performance.now();result=await nativeInput(b.tabId,plan.action,point,destination,async release=>{
              enforceRecipe(getPolicy(),recipe);await validateTab(b.tabId);if(run!==getGeneration())throw new PilotError('cancelled');
              await sensor(plan.frameId,{op:'native_validate',leaseId:prepared.leaseId,release});
              const actual=await rootPoint(plan.frameId,prepared.point);if(Math.abs(point.x-actual.x)>2||Math.abs(point.y-actual.y)>2)throw new PilotError('target_moved');
            },plan.dialog,current.origin);inputMs=performance.now()-dispatching;
            if(result.dispatch==='sent'&&(plan.action.type==='check'||plan.action.type==='fill')){
              try{const actual=await sensor(plan.frameId,{op:'native_finish',leaseId:prepared.leaseId});result.outcome=plan.action.type==='check'?(actual.checked===plan.action.checked?'verified':'failed'):(actual.value===plan.action.value?'verified':'unknown');}catch(error){result={...result,outcome:'unknown',code:error instanceof PilotError?error.code:'verification_failed'};}
            }
          }
        }else{
          try{result=await sensor(plan.frameId,{op:'action',snapshotId:current.snapshotId,action:plan.action});}
          catch(error){if(error instanceof PilotError)throw error;return {action:{dispatch:'unknown',outcome:'unknown'},readiness:{state:'interrupted',businessOutcomeVerified:false}};}
        }
        if(result.code==='needs_user'){handoff={tabId:b.tabId,origin:b.origin,reason:'unsupported_control'};return {action:result,readiness:{state:'needs_user',businessOutcomeVerified:false},code:'needs_user'};}
        const waiting=performance.now();
        // Allow a same-task navigation to settle, then bind its new document explicitly.
        const tab=await chrome.tabs.get(b.tabId);
        if(tab.status==='loading')await waitForTab(b.tabId,plan.timeoutMs).catch(()=>{});
        const docs=await chrome.webNavigation.getAllFrames({tabId:b.tabId}),top=docs?.find(frame=>frame.frameId===0);
        let expectedGeneration=run;
        if(top&&top.documentId!==b.documentId){
          const origin=exactOrigin(top.url);if(origin!==b.origin&&!allowedOrigins().includes(origin))return {action:{...result,outcome:'unknown'},readiness:{state:'scope_blocked',businessOutcomeVerified:false},code:'navigation_out_of_scope'};
          if(run!==getGeneration())throw new PilotError('cancelled');await rebind(b.tabId);expectedGeneration=getGeneration();snapshots.clear();loaded.clear();
        }
        let verified=false;
        if(plan.expect){
          const deadline=performance.now()+plan.timeoutMs;
          do{
            if(expectedGeneration!==getGeneration())throw new PilotError('cancelled');
            try{verified=(await sensor(plan.frameId,{op:'verify',expect:plan.expect})).verified;}catch(error){if((error as PilotError).code==='cancelled')throw error;break;}
            if(verified)break;await new Promise(resolve=>setTimeout(resolve,80));
          }while(performance.now()<deadline);
        }
        const readinessMs=performance.now()-waiting,observing=performance.now();let observed;
        for(let attempt=0;attempt<3;attempt++){
          try{observed=await state({frameId:plan.frameId,cursor:0,limit:60});break;}
          catch(error){
            if(!(error instanceof PilotError)||error.code!=='stale_binding'||result.dispatch!=='sent')throw error;
            const latest=(await chrome.webNavigation.getAllFrames({tabId:b.tabId}))?.find(frame=>frame.frameId===0);
            if(!latest||latest.documentId===binding().documentId)throw error;
            const origin=exactOrigin(latest.url);if(origin!==b.origin&&!allowedOrigins().includes(origin))return {action:{...result,outcome:'unknown'},readiness:{state:'scope_blocked',businessOutcomeVerified:false},code:'navigation_out_of_scope'};
            if(expectedGeneration!==getGeneration())throw new PilotError('cancelled');
            await rebind(b.tabId);expectedGeneration=getGeneration();snapshots.clear();loaded.clear();verified=false;
          }
        }
        if(!observed)return {action:result,readiness:{state:'navigation_pending',businessOutcomeVerified:false}};
        return {action:result,...observed,readiness:{state:plan.expect?(verified?'verified':'timeout'):'observed',businessOutcomeVerified:verified},timings:{totalMs:Math.round(performance.now()-start),nativePrepareMs:Math.round(nativePrepareMs),inputMs:Math.round(inputMs),readinessMs:Math.round(readinessMs),observationMs:Math.round(performance.now()-observing)}};
      });
    }
    throw new PilotError('unknown_command');
  }
  return {command,isHandedOff:()=>handoff!==undefined,async validateImages(images:{captureId:string;targetId:string;stateVersion:string;expiresAt:number}[]){const current=snapshots.get('0'),grant=visualGrant;for(const image of images)if(!current||!grant||grant.id!==image.captureId||grant.targetId!==image.targetId||grant.expires!==image.expiresAt||grant.expires<Date.now()||image.stateVersion!==current.documentId+':'+current.snapshotId||grant.documentId!==(await liveFrame(0)).documentId)throw new PilotError('stale_capture');},async fileTarget(version:string,targetId:string){const current=snapshots.get('0');if(!current||version!==current.documentId+':'+current.snapshotId||current.documentId!==(await liveFrame(0)).documentId)throw new PilotError('stale_snapshot');const target=current.targets.find(target=>target.id===targetId);if(target?.kind!=='file')throw new PilotError('stale_snapshot');return {target,token:current.documentToken};},async validateVersion(version:string){const current=[...snapshots.values()].find(snapshot=>version===snapshot.documentId+':'+snapshot.snapshotId);if(!current)return false;const live=await liveFrame(current.frameId);return live.documentId===current.documentId;},invalidate(){dispose();pending=undefined;capture=undefined;visualGrant=undefined;snapshots.clear();loaded.clear();}};
}
