import {actionSchema,outcomePredicate,observationDiff,type ObservationV2,type TargetV2} from '../capabilities.js';
import {Registry} from './registry.js';
import {accessibleName,ancestor,composedElements,content,description,role,section,visible} from './semantic.js';
import {reader,type ReadInput} from './reader.js';
import {domAction} from './controls.js';
import {exposedPoint,ready} from './actionability.js';
import {siteArguments,validateSiteSchema} from '../site-schema.js';
import {editorText} from './editor.js';
import {ownedCombobox} from './widgets.js';

type SensorInput={op:'observe'|'read'|'action'|'point'|'cancel'|'native_prepare'|'native_validate'|'native_finish'|'frame_arm'|'frame_send'|'frame_geometry'|'verify'|'capture_mask'|'capture_clear'|'capture_validate'|'download_target'|'site_discover'|'site_call';origin:string;sessionId:string;documentToken?:string;allowedOrigins?:string[];snapshotId?:string;cursor?:number;limit?:number;baseSnapshotId?:string;read?:ReadInput;action?:unknown;targetId?:string;leaseId?:string;nonce?:string;expect?:unknown;redactTargets?:string[];toolRef?:string;arguments?:unknown;release?:boolean;fresh?:boolean;visual?:{point:{x:number;y:number};rect:string}};
type World=typeof globalThis&{__taboraSiteAbort?:AbortController;__taboraFrameListener?:(event:MessageEvent)=>void;__taboraSensor?:{sessionId:string;registry:Registry;native?:{id:string;action:ReturnType<typeof actionSchema.parse>;expires:number;point:{x:number;y:number};identity:string;focus?:Element}};__taboraOperation?:(input:SensorInput)=>Promise<unknown>};
const world=globalThis as World;
// Re-injection begins a new sensor generation, including after extension/host reload.
world.__taboraSiteAbort?.abort();world.__taboraSiteAbort=undefined;world.__taboraSensor?.registry.close();world.__taboraSensor=undefined;
const selector='body,a[href],button,input:not([type="hidden"]),textarea,select,form,table,main,section,article,pre,svg,canvas,img,dialog,[contenteditable="true"],[role],[tabindex],[onclick],[draggable="true"]';
const frameRequests=new Map<string,{expires:number;element?:HTMLIFrameElement}>();
let masks:HTMLElement[]=[];
let maskExpiry:ReturnType<typeof setTimeout>|undefined;
let captureGuard:{target:Element;geometry:string;sensitive:string;extra:Element[];sessionId:string}|undefined;
const siteTools=new Map<string,{metadata:string;tool:any;sessionId:string}>();
async function bounded<T>(promise:Promise<T>,ms:number,code:string){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(code)),ms);})]);}finally{clearTimeout(timer);}}
function activeElement(){let active=document.activeElement;for(let depth=0;active instanceof HTMLElement&&depth<32;depth++){const inner=(active.shadowRoot??chrome.dom.openOrClosedShadowRoot(active))?.activeElement;if(!inner)break;active=inner;}return active;}
function clearMasks(){clearTimeout(maskExpiry);maskExpiry=undefined;masks.forEach(mask=>mask.remove());masks=[];captureGuard=undefined;}
const rectangle=(el:Element)=>{const r=el.getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height};};
function privateRegions(extra:Element[]){const scan=composedElements(document);if(scan.truncated)throw new Error('capture_redaction_incomplete');return [...scan.elements.filter(node=>node.matches('input,textarea,select,[contenteditable="true"],[data-private],[data-sensitive],iframe')),...extra];}
function writeIdentity(el:Element){const row=ancestor(el,'[data-id],[data-key],[aria-rowindex]');return JSON.stringify([el.tagName,el.getAttribute('role'),el.getAttribute('type'),el.getAttribute('href'),row?.getAttribute('data-id'),row?.getAttribute('data-key'),row?.getAttribute('aria-rowindex')]);}
if(world.__taboraFrameListener)removeEventListener('message',world.__taboraFrameListener);
world.__taboraFrameListener=event=>{
  const nonce=event.data?.taboraFrameGeometry;if(!event.isTrusted||typeof nonce!=='string')return;
  const request=frameRequests.get(nonce);if(!request||request.expires<Date.now())return;
  if(!request.element)request.element=Array.from(document.querySelectorAll('iframe')).find(frame=>frame.contentWindow===event.source);
};addEventListener('message',world.__taboraFrameListener);

function describe(el:Element):Omit<TargetV2,'id'>{
  const widget=ownedCombobox(el);if(widget){const target=describe(widget);return {...target,kind:'combobox',role:'combobox',visible:true,inputType:undefined,value:undefined,clickable:true};}
  const purpose=el.getAttribute('autocomplete')?.trim().split(/\s+/).at(-1);
  const inputPurpose=['username','current-password','new-password','one-time-code'].includes(purpose??'')?purpose as TargetV2['inputPurpose']:undefined;
  const r=role(el),type=el instanceof HTMLInputElement?el.type:el instanceof HTMLTextAreaElement?'textarea':undefined,secret=!!ancestor(el,'[data-private],[data-sensitive]')||type==='password'||['current-password','new-password','one-time-code'].includes(inputPurpose??'');
  const target:Omit<TargetV2,'id'>={kind:r,role:r,name:accessibleName(el),description:description(el),section:section(el),visible:visible(el),disabled:el.matches(':disabled')||el.getAttribute('aria-disabled')==='true'||!!ancestor(el,'[inert]'),readonly:el.getAttribute('aria-readonly')==='true'||!!(el as HTMLInputElement).readOnly,inputType:type,inputPurpose,secret:secret||undefined};
  // Page-world JavaScript listeners are not inspectable from the isolated sensor.
  // An explicit nonnegative tabindex is a shared DOM interaction hint for visual controls.
  const focusableVisual=['img','generic','region'].includes(r)&&el.hasAttribute('tabindex')&&(el as HTMLElement).tabIndex>=0;
  if(el.hasAttribute('onclick')||focusableVisual)target.clickable=true;if(el.getAttribute('draggable')==='true')target.draggable=true;
  if((el instanceof HTMLButtonElement||el instanceof HTMLInputElement)&&el.type==='submit'&&el.form){target.submitter=true;target.formValid=Array.from(el.form.elements).every(control=>!('willValidate' in control)||(control as HTMLInputElement).willValidate===false||(control as HTMLInputElement).validity.valid);}
  if(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement){if(!secret&&type!=='file')target.value=el.value.slice(0,2000);if(['checkbox','radio'].includes(type??''))target.checked=(el as HTMLInputElement).indeterminate?'mixed':(el as HTMLInputElement).checked;}
  if(el instanceof HTMLElement&&el.isContentEditable&&!secret){target.inputType='contenteditable';try{target.value=editorText(el).slice(0,2000);}catch{target.secret=true;target.readonly=true;}}
  if(el.hasAttribute('aria-checked'))target.checked=el.getAttribute('aria-checked')==='mixed'?'mixed':el.getAttribute('aria-checked')==='true';
  if(el.hasAttribute('aria-expanded'))target.expanded=el.getAttribute('aria-expanded')==='true';
  if(el.hasAttribute('aria-selected'))target.selected=el.getAttribute('aria-selected')==='true';
  if(el instanceof HTMLSelectElement){target.multiple=el.multiple;target.optionCount=el.options.length;target.options=Array.from(el.options).slice(0,40).map(o=>({index:o.index,label:o.text.slice(0,240),selected:o.selected,disabled:o.disabled||!!o.closest('optgroup[disabled]')}));}
  if(el instanceof HTMLInputElement&&el.type==='file'){target.accept=el.accept;target.multiple=el.multiple;}
  if(el instanceof HTMLAnchorElement){try{const url=new URL(el.href);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)target.href=url.href;}catch{}}
  if(el.matches('table,[role="grid"],[role="table"]')){target.rowCount=el.querySelectorAll('tr,[role="row"]').length;const total=Number(el.getAttribute('aria-rowcount'));target.totalRows=total>0?total:target.rowCount;target.virtualized=total>target.rowCount;}
  target.recordKey=el.getAttribute('data-id')??el.getAttribute('data-key')??el.getAttribute('aria-rowindex')??undefined;
  const style=getComputedStyle(el);if(/auto|scroll/.test(style.overflowY)&&el.scrollHeight>el.clientHeight||el===document.scrollingElement){target.scrollable=true;target.scroll={x:el.scrollLeft,y:el.scrollTop,viewportWidth:el.clientWidth,viewportHeight:el.clientHeight,maxX:Math.max(0,el.scrollWidth-el.clientWidth),maxY:Math.max(0,el.scrollHeight-el.clientHeight)};}
  return target;
}
world.__taboraOperation=async(input:SensorInput)=>{
  try{
    if(input.origin!==location.origin||!['https:','http:'].includes(location.protocol))throw new Error('stale_binding');
    if(input.op==='cancel'){if(world.__taboraSensor?.sessionId===input.sessionId&&(!input.documentToken||world.__taboraSensor.registry.token===input.documentToken)){world.__taboraSiteAbort?.abort();world.__taboraSiteAbort=undefined;siteTools.clear();clearMasks();world.__taboraSensor.registry.close();world.__taboraSensor=undefined;}return {ok:true};}
    if(world.__taboraSensor&&world.__taboraSensor.sessionId!==input.sessionId){world.__taboraSensor.registry.close();world.__taboraSensor=undefined;}
    const state=world.__taboraSensor??={sessionId:input.sessionId,registry:new Registry()},registry=state.registry;
    registry.watch(document.documentElement);
    if(input.op==='site_discover'||input.op==='site_call'){
      const context=(document as any).modelContext;
      if(!isSecureContext||typeof context?.getTools!=='function'||typeof context?.executeTool!=='function')return {ok:true,status:'unsupported',reason:'webmcp_runtime_unavailable',tools:[]};
      const tools=(await bounded<any[]>(Promise.resolve(context.getTools()),3000,'site_discovery_timeout')).filter((tool:any)=>tool.origin===location.origin&&tool.window===window).slice(0,20);
      const metadata=(tool:any)=>JSON.stringify({name:tool.name,description:tool.description,inputSchema:tool.inputSchema,origin:tool.origin});
      if(input.op==='site_discover'){
        siteTools.clear();context.addEventListener('toolchange',()=>siteTools.clear(),{once:true});
        const rejected:{name:string;code:string}[]=[];let budget=24000;const discovered=tools.flatMap((tool:any)=>{const value=metadata(tool);if(value.length>12000||value.length>budget||typeof tool.name!=='string'||tool.name.length>120)return [];let schema;try{schema=validateSiteSchema(tool.inputSchema);}catch{rejected.push({name:tool.name,code:'unsupported_site_schema'});return [];}budget-=value.length;const ref=crypto.randomUUID();siteTools.set(ref,{metadata:value,tool,sessionId:input.sessionId});return [{ref,name:tool.name,description:String(tool.description).slice(0,500),inputSchema:schema,origin:tool.origin,trust:'untrusted'}];});
        return {ok:true,status:'experimental',tools:discovered,rejected,documentToken:registry.token};
      }
      const entry=siteTools.get(input.toolRef!);siteTools.delete(input.toolRef!);
      if(!entry||entry.sessionId!==input.sessionId||!tools.some((tool:any)=>metadata(tool)===entry.metadata))throw new Error('stale_site_tool');
      siteArguments(entry.tool.inputSchema,input.arguments);
      const controller=new AbortController();world.__taboraSiteAbort=controller;const timer=setTimeout(()=>controller.abort(),10000),major=Number(navigator.userAgent.match(/(?:Chrome|Chromium)\/(\d+)/)?.[1]??0);
      try{const result=await bounded(Promise.resolve(context.executeTool(entry.tool,major>=155?input.arguments:JSON.stringify(input.arguments),{signal:controller.signal})),10000,'site_tool_timeout'),text=typeof result==='string'?result:JSON.stringify(result)??'null';return {ok:true,dispatch:'sent',outcome:'unverified',text:text.slice(0,16000),truncated:text.length>16000,provenance:{source:'site_tool',trust:'untrusted',origin:location.origin,documentToken:registry.token}};}
      catch{return {ok:true,dispatch:'unknown',outcome:'unknown',code:'site_tool_interrupted'};}finally{clearTimeout(timer);if(world.__taboraSiteAbort===controller)world.__taboraSiteAbort=undefined;}
    }
    if(input.op==='capture_clear'){clearMasks();return {ok:true};}
    if(input.op==='capture_validate'){
      if(!captureGuard||captureGuard.sessionId!==input.sessionId||!captureGuard.target.isConnected||JSON.stringify(rectangle(captureGuard.target))!==captureGuard.geometry||JSON.stringify(privateRegions(captureGuard.extra).map(rectangle))!==captureGuard.sensitive)throw new Error('capture_redaction_changed');
      return {ok:true};
    }
    if(input.op==='capture_mask'||input.op==='download_target'){
      const snapshot=registry.snapshots.get(input.snapshotId??'');if(!snapshot?.targets.some(target=>target.id===input.targetId))throw new Error('stale_snapshot');
      const el=registry.resolve(input.targetId!,true).el;ready(el);
      if(input.op==='download_target'){
        if(!(el instanceof HTMLAnchorElement))throw new Error('wrong_target_kind');const url=new URL(el.href);
        if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.origin!==location.origin)throw new Error('navigation_out_of_scope');
        registry.snapshots.delete(snapshot.snapshotId);return {ok:true,url:url.href};
      }
      clearMasks();exposedPoint(el);
      const rect=el.getBoundingClientRect(),left=Math.max(0,rect.left),top=Math.max(0,rect.top),width=Math.min(innerWidth,rect.right)-left,height=Math.min(innerHeight,rect.bottom)-top;
      if(width<=0||height<=0||width*height>16000000)throw new Error('image_size_limit');
      const extra=(input.redactTargets??[]).map(id=>registry.resolve(id).el),sensitive=privateRegions(extra);
      const pixelRedaction={width,height,masks:sensitive.map(node=>{const r=rectangle(node);return {...r,x:r.x-left,y:r.y-top};})};
      captureGuard={target:el,geometry:JSON.stringify(rectangle(el)),sensitive:JSON.stringify(sensitive.map(rectangle)),extra,sessionId:input.sessionId};
      for(const node of sensitive){const r=node.getBoundingClientRect();if(!r.width||!r.height)continue;const mask=document.createElement('div');mask.setAttribute('aria-hidden','true');mask.style.cssText=`position:fixed!important;left:${r.left}px!important;top:${r.top}px!important;width:${r.width}px!important;height:${r.height}px!important;background:#000!important;z-index:2147483647!important;pointer-events:none!important;`;document.documentElement.append(mask);masks.push(mask);}
      maskExpiry=setTimeout(clearMasks,5000);await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
      return {ok:true,clip:{x:left+scrollX,y:top+scrollY,width,height,scale:1},targetRect:JSON.stringify(rectangle(el)),viewport:{x:left,y:top},pixelRedaction,provenance:{source:'page',trust:'untrusted',documentToken:registry.token,targetId:input.targetId,origin:location.origin,path:location.pathname},redactedRegions:sensitive.length};
    }
    if(input.op==='verify'){
      const expect=outcomePredicate.parse(input.expect);if(expect.type==='url')return {ok:true,verified:location.href===expect.equals};
      const el=registry.resolve(expect.targetId).el;
      if(expect.type==='value'){if(!(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement)||el.type==='password')throw new Error('sensitive_or_unsupported_field');return {ok:true,verified:el.value===expect.equals};}
      if(expect.type==='checked')return {ok:true,verified:(el instanceof HTMLInputElement?el.checked:el.getAttribute('aria-checked')==='true')===expect.equals};
      return {ok:true,verified:reader(registry,{targetId:expect.targetId,format:'text',offset:0,limit:16000}).text?.includes(expect.contains)??false};
    }
    if(input.op==='frame_arm'){for(const [key,value] of frameRequests)if(value.expires<Date.now())frameRequests.delete(key);if(frameRequests.size>=64)throw new Error('frame_limit');frameRequests.set(input.nonce!,{expires:Date.now()+5000});return {ok:true};}
    if(input.op==='frame_send'){parent.postMessage({taboraFrameGeometry:input.nonce},'*');return {ok:true};}
    if(input.op==='frame_geometry'){
      const request=frameRequests.get(input.nonce!),deadline=performance.now()+250;
      // Delivery is asynchronous across renderer frames; wait for the nonce reply,
      // not for page-wide network or DOM idleness.
      while(request&&!request.element&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
      const el=request?.element;frameRequests.delete(input.nonce!);
      if(!el?.isConnected)throw new Error('frame_geometry_unavailable');ready(el);
      const rect=el.getBoundingClientRect(),style=getComputedStyle(el),matrix=new DOMMatrix(style.transform==='none'?undefined:style.transform);
      if(matrix.b||matrix.c||!matrix.is2D||rect.width<=0||rect.height<=0)throw new Error('unsupported_frame_transform');
      const sx=rect.width/el.offsetWidth,sy=rect.height/el.offsetHeight;
      return {ok:true,geometry:{x:rect.x+el.clientLeft*sx,y:rect.y+el.clientTop*sy,sx,sy,width:el.clientWidth,height:el.clientHeight}};
    }
    if(input.op==='native_validate'||input.op==='native_finish'){
      const lease=state.native;if(!lease||lease.id!==input.leaseId||lease.expires<Date.now())throw new Error('decision_expired');
      const el=registry.resolve(lease.action.targetId,!input.release).el;if(writeIdentity(el)!==lease.identity)throw new Error('stale_reference');if(input.release)return {ok:true};ready(el);if(input.op==='native_finish'){state.native=undefined;return {ok:true,checked:el instanceof HTMLInputElement?el.checked:el.getAttribute('aria-checked')==='true',value:el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement?el.value:undefined};}
      if(lease.focus&&activeElement()!==lease.focus)throw new Error('focus_lost');
      if(el instanceof HTMLInputElement&&el.type==='password')throw new Error('sensitive_or_unsupported_field');
      const point=exposedPoint(el,lease.action.type==='image_click'?lease.point:undefined);if(Math.abs(point.x-lease.point.x)>2||Math.abs(point.y-lease.point.y)>2)throw new Error('target_moved');
      return {ok:true};
    }
    if(input.op==='observe'){
      const started=performance.now(),scan=registry.scan(input.fresh),candidates=scan.elements.filter(el=>(el.matches(selector)||ownedCombobox(el)||el.scrollHeight>el.clientHeight&&/auto|scroll/.test(getComputedStyle(el).overflowY))&&(!['SCRIPT','STYLE','NOSCRIPT'].includes(el.tagName)));
      const cursor=input.cursor??0,limit=Math.min(100,input.limit??60),targets:TargetV2[]=[];let seen=0,budget=24000;
      let semanticHits=0,metadataTruncated=false;
      for(const el of candidates){
        const root=el.getRootNode();if(root instanceof ShadowRoot)registry.watch(root);
        let description;try{description=registry.describe(el,describe);}catch(error){if(error instanceof Error&&error.message==='reader_size_limit'){metadataTruncated=true;continue;}throw error;}const target=description.value;if(description.cached)semanticHits++;if(!target.visible&&target.kind!=='file')continue;
        if(seen++<cursor)continue;
        const size=JSON.stringify(target).length+120;
        if(targets.length===limit||size>budget)break;budget-=size;targets.push(registry.register(el,target));
      }
      registry.prune();const next=seen>cursor+targets.length?cursor+targets.length:null;
      let data='';try{data=content(document.body,32000);}catch(error){if(error instanceof Error&&error.message==='reader_size_limit')metadataTruncated=true;else throw error;}let hash=2166136261;for(let index=0;index<data.length;index++)hash=Math.imul(hash^data.charCodeAt(index),16777619);
      const snapshot:ObservationV2={schemaVersion:2,snapshotId:crypto.randomUUID(),epoch:registry.epoch,dataVersion:String(hash>>>0),origin:location.origin,path:location.pathname,title:document.title.slice(0,500),targets,coverage:{scanned:scan.elements.length,targetCount:targets.length,truncated:scan.truncated||next!==null,cursor,nextCursor:next},provenance:{source:'page',trust:'untrusted',documentToken:registry.token}};
      const sequence=candidates.filter(el=>visible(el)||el instanceof HTMLInputElement&&el.type==='file').map(el=>registry.reference(el)).join(',');
      const previous=cursor===0&&input.baseSnapshotId?registry.snapshots.get(input.baseSnapshotId):undefined,continuationOf=registry.save(snapshot,sequence);
      snapshot.coverage.truncated ||= metadataTruncated;return {ok:true,snapshot:previous?observationDiff(previous,snapshot):snapshot,fullSnapshot:!previous,continuationOf,timings:{sensorMs:Math.round(performance.now()-started),treeCacheHit:scan.cached,semanticHits}};
    }
    if(input.op==='read')return {ok:true,...reader(registry,input.read!)};
    const baseline=input.snapshotId?registry.snapshots.get(input.snapshotId):undefined;
    if(!baseline)throw new Error('stale_snapshot');
    const targetId=input.op==='point'?input.targetId!:actionSchema.parse(input.action).targetId;
    if(!baseline.targets.some(t=>t.id===targetId))throw new Error('unobserved_target');
    if(input.op==='point'){const entry=registry.resolve(targetId,true);ready(entry.el);return {ok:true,point:exposedPoint(entry.el),epoch:registry.epoch,token:registry.token};}
    const action=actionSchema.parse(input.action);
    if(action.type==='drag'&&!baseline.targets.some(t=>t.id===action.destinationId))throw new Error('unobserved_target');
    // Consume before dispatch. The caller must observe a new snapshot before another write.
    registry.snapshots.delete(baseline.snapshotId);
    if(input.op==='native_prepare'){
      const el=registry.resolve(action.targetId,true).el;ready(el);
      if(el instanceof HTMLInputElement&&['password','file'].includes(el.type)||ancestor(el,'[data-private],[data-sensitive]')||['current-password','new-password','one-time-code'].includes(el.getAttribute('autocomplete')?.trim().split(/\s+/).at(-1)??''))throw new Error('sensitive_or_unsupported_field');
      if(el instanceof HTMLAnchorElement){const url=new URL(el.href);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.origin!==location.origin&&!input.allowedOrigins?.includes(url.origin))throw new Error('navigation_out_of_scope');}
      if(action.type==='check'){
        const checked=el instanceof HTMLInputElement?el.checked:el.getAttribute('aria-checked')==='true';
        if(checked===action.checked&&el.getAttribute('aria-checked')!=='mixed'&&!(el instanceof HTMLInputElement&&el.indeterminate))return {ok:true,dispatch:'not_needed',outcome:'verified'};
        if(!el.matches('input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="radio"],[role="switch"]'))throw new Error('wrong_target_kind');
        if(!action.checked&&el.matches('input[type="radio"],[role="radio"]'))throw new Error('unsupported_radio_uncheck');
      }
      if(action.type==='image_click'&&(!input.visual||JSON.stringify(rectangle(el))!==input.visual.rect))throw new Error('stale_capture');
      const point=exposedPoint(el,action.type==='image_click'?input.visual!.point:undefined);
      const initial=el.getBoundingClientRect();await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
      const final=el.getBoundingClientRect();if(['x','y','width','height'].some(key=>Math.abs((initial as any)[key]-(final as any)[key])>1))throw new Error('target_moved');
      if(action.type==='key'){if(!(el instanceof HTMLElement))throw new Error('wrong_target_kind');const focus=ownedCombobox(el)??el;focus.focus();if(activeElement()!==focus)throw new Error('focus_failed');}
      if(action.type==='fill'){if(!(el instanceof HTMLTextAreaElement)&&!(el instanceof HTMLInputElement&&['text','email','search','tel','url'].includes(el.type)))throw new Error('unsupported_native_field');ready(el,true);el.focus();el.select();if(activeElement()!==el)throw new Error('focus_failed');}
      const destination=action.type==='drag'?exposedPoint(registry.resolve(action.destinationId,true).el):undefined;
      state.native={id:crypto.randomUUID(),action,expires:Date.now()+15000,point,identity:writeIdentity(el),focus:['key','fill'].includes(action.type)?activeElement()??undefined:undefined};
      return {ok:true,leaseId:state.native.id,point,destination};
    }
    return {ok:true,...domAction(registry,action,input.allowedOrigins)};
  }catch(error){return {ok:false,code:error instanceof Error&&/^[a-z_]+$/.test(error.message)?error.message:'invalid_request'};}
};
