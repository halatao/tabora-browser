import { z } from 'zod';
import { HOST_NAME, PROTOCOL_VERSION, PilotError, safeCode, exactOrigin, profileSchema,providerSelectSchema,providerConfigureSchema, type BrowserProfile } from '../shared.js';
import { createBrowserSession, type BrowserSession } from './session.js';
import { nativeErrorCode } from './native-errors.js';
import {enforceSafeTab,ownsCleanupTab} from './policy.js';
import {waitForTab} from './readiness.js';
import {buildInfo} from '../build-info.js';

let native:chrome.runtime.Port|undefined,connecting:Promise<void>|undefined,profile:BrowserProfile,reconnectAttempts=0;
const requests=new Map<string,{resolve:(data:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
type Workspace={session:BrowserSession;runId?:string;windowId?:number;safeWindowId?:number;groupId?:number;tabs:Set<number>;createdTabs:Set<number>;createdLocations:Map<number,{windowId:number;groupId:number}>;busy:boolean;closed:boolean;allowPopups:boolean;allowedOrigins:string[];popups:Map<number,{tabId:number;status:'pending'|'ready'|'denied';code?:string}>};
const sessions=new Map<string,Workspace>(),owners=new Map<number,string>();
async function safeWindow(windowId?:number){
  if(windowId!==undefined){
    const window=await chrome.windows.get(windowId);
    if(window.type!=='normal'||window.incognito)throw new PilotError('unsupported_window');
    return window;
  }
  const focused=await chrome.windows.getLastFocused({windowTypes:['normal']}).catch(()=>undefined);
  if(focused?.id!==undefined&&!focused.incognito)return focused;
  return (await chrome.windows.getAll({windowTypes:['normal']})).find(window=>!window.incognito);
}
function workspace(id:string,name:string,external=false,windowId?:number,allowedOrigins:string[]=[],allowPopups=false,siteTools=false){
  if(sessions.has(id))throw new PilotError('duplicate_session');if(sessions.size>=40)throw new PilotError('session_limit');
  const w:Workspace={session:createBrowserSession(id,name,external,(command,payload)=>host(command,payload,id),()=>({mode:profile.mode??'safe',vaultEnabled:profile.vaultEnabled??false}),async tabId=>enforceSafeTab(profile,await chrome.tabs.get(tabId),w),()=>allowedOrigins,()=>siteTools),tabs:new Set(),createdTabs:new Set(),createdLocations:new Map(),windowId,busy:false,closed:false,allowPopups,allowedOrigins,popups:new Map()};sessions.set(id,w);return w;
}
function send(command:string,payload?:unknown,sessionId='panel'):Promise<any>{
  return new Promise((resolve,reject)=>{
    const id=crypto.randomUUID(),timer=setTimeout(()=>{requests.delete(id);reject(new PilotError('host_timeout'));native?.disconnect();},125000);
    requests.set(id,{resolve,reject,timer});
    try{native!.postMessage({id,version:PROTOCOL_VERSION,command,payload,sessionId});}catch{clearTimeout(timer);requests.delete(id);reject(new PilotError('native_host_unavailable'));}
  });
}
async function ensureConnected(){
  if(connecting)return connecting;
  connecting=(async()=>{
    await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
    const stored=(await chrome.storage.local.get('profile')).profile;
    profile=profileSchema.parse({id:crypto.randomUUID(),name:'Chrome',mcpEnabled:true,mode:'safe',vaultEnabled:false,activeProvider:'agent',nameSource:'automatic',...(stored?profileSchema.parse(stored):{})});
    await chrome.storage.local.set({profile});
    native=chrome.runtime.connectNative(HOST_NAME);
    const port=native;
    native.onMessage.addListener(message=>{
      if(message?.event==='browser-command'){
        const reply=(value:unknown)=>{try{port.postMessage(value);}catch{/* Disconnected actions are never replayed on a new connection. */}};
        void dispatch(message.command,message.payload,message.source==='controller'?'controller':'mcp').then(data=>reply({event:'browser-result',id:message.id,ok:true,data}),error=>reply({event:'browser-result',id:message.id,ok:false,code:safeCode(error)}));return;
      }
      const req=requests.get(message.id);if(!req)return;clearTimeout(req.timer);requests.delete(message.id);
      if(message.ok)req.resolve(message.data);else req.reject(new PilotError(message.code??'host_error'));
    });
    native.onDisconnect.addListener(()=>{
      const code=nativeErrorCode(chrome.runtime.lastError?.message);
      if(native!==port)return;
      native=undefined;connecting=undefined;
      for(const w of sessions.values())w.session.invalidate(false);sessions.clear();owners.clear();
      for(const req of requests.values()){clearTimeout(req.timer);req.reject(new PilotError(code));}requests.clear();
      // No action is replayed. Reconnect only registers this profile again.
      setTimeout(()=>void ensureConnected().catch(()=>{}),Math.min(30000,1000*2**Math.min(reconnectAttempts++,5))+Math.floor(Math.random()*250));
    });
    await send('hello',profile);
    const hostIdentity=await send('status');
    if(!hostIdentity.build||hostIdentity.build.contractVersion!==buildInfo.contractVersion){native?.disconnect();throw new PilotError('host_update_required');}
    reconnectAttempts=0;
    if(profile.nameSource!=='legacy'){
      try{const detected=await send('profile.detect',{browser:/Edg\//.test(navigator.userAgent)?'edge':'chrome',key:profile.browserProfileKey});
        if(detected.automatic){profile={...profile,name:detected.automatic.name,browserProfileKey:detected.automatic.key};await chrome.storage.local.set({profile});await send('profile.update',profile);}
      }catch{/* Connection remains usable when a browser has no identifiable profile metadata. */}
    }
    workspace('panel','Ruční úloha');
  })().catch(error=>{native?.disconnect();connecting=undefined;throw error;});
  return connecting;
}
async function host(command:string,payload?:unknown,sessionId='panel'){await ensureConnected();return send(command,payload,sessionId);}
function summary(w:Workspace){return {id:w.session.id,name:w.session.name,external:w.session.external,windowId:w.windowId,groupId:w.groupId,tabIds:[...w.tabs],binding:w.session.binding,busy:w.busy||w.session.busy};}
async function release(w:Workspace,closeCreatedTabs=false){
  w.closed=true;
  const closedTabIds:number[]=[],retainedTabIds:number[]=[],failedTabIds:number[]=[];
  try{
    await w.session.release();
    if(closeCreatedTabs)for(const id of [...w.createdTabs]){
      try{
        const tab=await chrome.tabs.get(id);
        const location=w.createdLocations.get(id);
        if(!location||!ownsCleanupTab(tab,{createdTabs:w.createdTabs,...location},owners.get(id),w.session.id)){retainedTabIds.push(id);continue;}
        await chrome.tabs.remove(id);closedTabIds.push(id);
      }catch{
        // An already removed tab needs no cleanup; other failures remain visible to the caller.
        if(await chrome.tabs.query({}).then(tabs=>tabs.some(tab=>tab.id===id)).catch(()=>true))failedTabIds.push(id);
      }
    }
  }finally{for(const id of w.tabs)if(owners.get(id)===w.session.id)owners.delete(id);sessions.delete(w.session.id);}
  return {released:true,tabsClosed:closeCreatedTabs&&retainedTabIds.length===0&&failedTabIds.length===0,closedTabIds,retainedTabIds,failedTabIds};
}
function notifyProviderChange(){void chrome.runtime.sendMessage({event:'provider.settings.changed'}).catch(()=>{});}
async function updateProfile(input:unknown){
    const next=profileSchema.parse({...profile,...input as object,id:profile.id});
    const policyChanged=next.mode!==profile.mode||next.vaultEnabled!==profile.vaultEnabled||next.activeProvider!==profile.activeProvider||next.mcpEnabled!==profile.mcpEnabled;
    const vaultDisabled=profile.vaultEnabled&&!next.vaultEnabled;
    profile=next;
    if(policyChanged)for(const w of sessions.values())w.session.invalidate();
    await chrome.storage.local.set({profile});await host('profile.update',profile);
    if(vaultDisabled)await host('vault.lock');
    if(!profile.mcpEnabled)await Promise.allSettled([...sessions.values()].filter(w=>w.session.external).map(w=>release(w)));return profile;
}
async function dispatch(name:string,input:any,source:'panel'|'mcp'|'controller'):Promise<any>{
  if(source==='panel'&&['files.requests','files.begin','files.chunk','files.finish','files.fulfill','files.cancel','files.release'].includes(name)){
    await ensureConnected();const {sessionId='panel',...payload}=input??{},workspace=sessions.get(sessionId);
    if(!payload.requestId&&name!=='files.requests'&&(!workspace||workspace.closed||workspace.session.external))throw new PilotError('session_not_owned');
    return host(name,payload,sessionId);
  }
  await ensureConnected();
  if(name==='configuration.changed'){
    if(source!=='mcp')throw new PilotError('forbidden');
    for(const w of sessions.values())w.session.invalidate();return {invalidated:true};
  }
  if(source==='controller'&&!['status','select','cancel','pin','popups.list','vault.list','v2.capabilities','v2.frames','v2.state','v2.read','v2.plan','v2.commit','v2.credential','v2.handoff','v2.site_tools','v2.site_call','v2.download','v2.capture','v2.capture_chunk','v2.capture_release','files.upload'].includes(name))throw new PilotError('forbidden');
  if(source==='mcp'&&!profile.mcpEnabled&&name!=='session.release')throw new PilotError('mcp_access_disabled');
  if(name==='profile.detect'){if(source!=='panel')throw new PilotError('forbidden');return host(name,input);}
  if(name==='provider.status'){
    if(source!=='mcp')throw new PilotError('forbidden');
    const {configs,providers}=await host('status');return {profileId:profile.id,activeProvider:profile.activeProvider??'agent',settingsScope:'host',configs,providers};
  }
  if(name==='provider.configure'){
    if(source!=='mcp')throw new PilotError('forbidden');
    const result=await host(name,providerConfigureSchema.parse(input));notifyProviderChange();return {...result,settingsScope:'host'};
  }
  if(name==='provider.select'){
    if(source!=='mcp')throw new PilotError('forbidden');
    const {provider}=providerSelectSchema.parse(input);
    const result=await updateProfile({activeProvider:provider});notifyProviderChange();return result;
  }
  if(name==='profile.update'){
    if(source!=='panel')throw new PilotError('forbidden');
    return updateProfile(input);
  }
  if(name==='sessions.list')return [...sessions.values()].map(summary);
  if(name==='session.create'){
    const p=z.object({id:z.string().uuid().optional(),name:z.string().trim().min(1).max(80),windowId:z.number().int().nonnegative().optional(),allowedOrigins:z.array(z.string().url()).max(16).optional(),allowPopups:z.boolean().default(false),siteTools:z.boolean().default(false)}).strict().parse(input);
    if(p.windowId!==undefined){if(profile.mode==='safe')await safeWindow(p.windowId);else await chrome.windows.get(p.windowId);}
    return summary(workspace(p.id??crypto.randomUUID(),p.name,source==='mcp',p.windowId,(p.allowedOrigins??[]).map(url=>exactOrigin(url)),p.allowPopups,p.siteTools));
  }
  if(name==='tabs.list')return (await chrome.tabs.query({})).filter(t=>/^https?:/.test(t.url??'')&&(profile.mode!=='safe'||[...sessions.values()].some(w=>w.createdTabs.has(t.id!)&&w.safeWindowId===t.windowId&&w.groupId===t.groupId))).map(t=>({id:t.id,windowId:t.windowId,groupId:t.groupId,url:t.url,title:t.title,ownerSessionId:owners.get(t.id!)}));
  if(['configure','provider.catalog','vault.unlock','vault.lock','vault.list','vault.put','vault.remove','vault.scope'].includes(name)){
    if(source==='mcp'&&!['vault.list','provider.catalog'].includes(name))throw new PilotError('forbidden');
    if(name.startsWith('vault.')&&name!=='vault.lock'&&!profile.vaultEnabled)throw new PilotError('vault_disabled');
    if(['configure','vault.lock','vault.put','vault.remove','vault.scope'].includes(name))for(const w of sessions.values())w.session.invalidate();
    return host(name,input);
  }
  const {sessionId='panel',...payload}=input??{};
  const w=sessions.get(sessionId);if(!w||w.closed)throw new PilotError('unknown_session');
  if(source==='panel'&&w.session.external&&!['status','cancel','session.release'].includes(name))throw new PilotError('session_owned_by_mcp');
  if(source==='controller'&&w.session.external)throw new PilotError('session_not_owned');
  if(source==='mcp'&&!w.session.external)throw new PilotError('session_not_owned');
  if(name==='run.start'){
    if(source!=='panel'||w.runId)throw new PilotError('run_active');
    const result=await host(name,payload,sessionId);w.runId=result.id;return result;
  }
  if(name==='run.status'||name==='run.cancel'){
    if(source!=='panel'||!w.runId||payload.runId!==w.runId)throw new PilotError('run_not_owned');
    const result=await host(name,payload,sessionId);if(result.status!=='running')w.runId=undefined;return result;
  }
  if(source==='panel'&&w.runId&&!['status','cancel','session.release'].includes(name))throw new PilotError('run_active');
  if(name==='status')return {...await w.session.invoke(name),extensionBuild:buildInfo,profile,sessions:[...sessions.values()].map(summary)};
  if(name==='popups.list')return {popups:[...w.popups.values()]};
  if(name==='session.release'){const p=z.object({closeCreatedTabs:z.boolean().default(false)}).strict().parse(payload);return release(w,p.closeCreatedTabs);}
  if(name==='cancel'){w.runId=undefined;return w.session.invoke(name);}
    if(name==='files.invalidate')return w.session.invoke(name,payload);
  if(w.busy)throw new PilotError('busy');w.busy=true;
  try{
    if(w.session.binding&&['observe','decide','manual','execute','step','select','benchmark','files.upload'].includes(name))enforceSafeTab(profile,await chrome.tabs.get(w.session.binding.tabId),w);
    if(name==='tabs.open'){
      const p=z.object({url:z.string().url().max(2048),active:z.boolean().default(false),waitForReady:z.boolean().optional(),readinessTimeoutMs:z.number().int().min(1000).max(60000).default(45000)}).strict().parse(payload);exactOrigin(p.url);
      let tab:chrome.tabs.Tab;
      if(profile.mode==='safe'&&w.safeWindowId===undefined){
        const existing=await safeWindow(w.windowId);
        if(existing?.id!==undefined){tab=await chrome.tabs.create({url:p.url,active:p.active,windowId:existing.id});w.safeWindowId=existing.id;}
        else {const opened=await chrome.windows.create({url:p.url,focused:p.active,type:'normal'});if(opened?.id===undefined)throw new PilotError('tab_open_failed');tab=opened.tabs?.[0]??(await chrome.tabs.query({windowId:opened.id}))[0];w.safeWindowId=opened.id;}
        w.windowId=w.safeWindowId;w.groupId=undefined;
      }else tab=await chrome.tabs.create({url:p.url,active:p.active,windowId:profile.mode==='safe'?w.safeWindowId:w.windowId});
      if(tab?.id===undefined)throw new PilotError('tab_open_failed');const tabId=tab.id;
      if(w.closed){return {tabId,opened:true,attached:false,code:'session_closed'};}
      w.tabs.add(tabId);w.createdTabs.add(tabId);owners.set(tabId,sessionId);w.windowId=tab.windowId;
      // Failure leaves the created tab visible and tracked; never retry creating it implicitly.
      try{
        if(w.groupId!==undefined){const group=await chrome.tabGroups.get(w.groupId).catch(()=>undefined);if(!group||group.windowId!==tab.windowId)w.groupId=undefined;}
        w.groupId=await chrome.tabs.group({tabIds:[tabId],...(w.groupId===undefined?{createProperties:{windowId:tab.windowId}}:{groupId:w.groupId})});
        w.createdLocations.set(tabId,{windowId:tab.windowId,groupId:w.groupId});
        await chrome.tabGroups.update(w.groupId,{title:w.session.name,color:'blue'});
      }catch{return {tabId,windowId:tab.windowId,opened:true,grouped:false,attached:false,code:'group_failed'};}
      if(p.waitForReady){
        try{await waitForTab(tabId,p.readinessTimeoutMs,true);if(w.closed)throw new PilotError('session_closed');const binding=await w.session.invoke('pin',{tabId});return {tabId,groupId:w.groupId,windowId:tab.windowId,opened:true,attached:true,binding};}
        catch(error){return {tabId,groupId:w.groupId,windowId:tab.windowId,opened:true,attached:false,code:safeCode(error)};}
      }
      return {tabId,groupId:w.groupId,windowId:tab.windowId,opened:true,attached:false,next:'Wait for the page to load, then attach this tab.'};
    }
    if(name==='pin'){
      const tabId=z.number().int().nonnegative().parse(payload.tabId),owner=owners.get(tabId);
      if(owner&&owner!==sessionId)throw new PilotError('tab_in_use');
      enforceSafeTab(profile,await chrome.tabs.get(tabId),w);
      owners.set(tabId,sessionId);
      try{const binding=await w.session.invoke(name,{tabId});w.windowId=(await chrome.tabs.get(tabId)).windowId;w.tabs.add(tabId);return binding;}
      catch(error){if(!owner)owners.delete(tabId);throw error;}
    }
    return await w.session.invoke(name,payload);
  }finally{w.busy=false;}
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message?.event)return;
  if(sender.id!==chrome.runtime.id||sender.url?.split('?')[0]!==chrome.runtime.getURL('panel.html'))return;
  void dispatch(message.command,message.payload,'panel').then(data=>reply({ok:true,data}),error=>reply({ok:false,code:error instanceof PilotError?error.code:'browser_error'}));return true;
});
chrome.tabs.onRemoved.addListener(tabId=>{
  const w=sessions.get(owners.get(tabId)??'');if(w){w.tabs.delete(tabId);w.createdTabs.delete(tabId);w.createdLocations.delete(tabId);if(w.session.binding?.tabId===tabId)w.session.invalidate();}owners.delete(tabId);
});
chrome.tabs.onCreated.addListener(tab=>{
  if(tab.id===undefined||tab.openerTabId===undefined)return;
  const w=sessions.get(owners.get(tab.openerTabId)??''),origin=w?.session.binding?.origin;
  if(!w||w.closed||w.session.binding?.tabId!==tab.openerTabId||!origin||w.popups.size>=20)return;
  const record:{tabId:number;status:'pending'|'ready'|'denied';code?:string}={tabId:tab.id,status:w.allowPopups?'pending':'denied',code:w.allowPopups?undefined:'popup_not_granted'};w.popups.set(tab.id,record);
  if(!w.allowPopups)return;
  void (async()=>{
    await waitForTab(tab.id!,10000,true);const live=await chrome.tabs.get(tab.id!);if(w.closed||owners.has(tab.id!))throw new PilotError('session_closed');
    const finalOrigin=exactOrigin(live.url??'');if(finalOrigin!==origin&&!w.allowedOrigins.includes(finalOrigin))throw new PilotError('navigation_out_of_scope');
    if(!await chrome.permissions.contains({origins:[finalOrigin+'/*']}))throw new PilotError('site_permission_required');
    if(w.windowId===undefined||w.groupId===undefined)throw new PilotError('group_unavailable');
    if(live.windowId!==w.windowId)await chrome.tabs.move(tab.id!,{windowId:w.windowId,index:-1});
    await chrome.tabs.group({tabIds:[tab.id!],groupId:w.groupId});if(w.closed)throw new PilotError('session_closed');
    w.tabs.add(tab.id!);w.createdTabs.add(tab.id!);w.createdLocations.set(tab.id!,{windowId:w.windowId,groupId:w.groupId});owners.set(tab.id!,w.session.id);record.status='ready';
  })().catch(error=>{record.status='denied';record.code=safeCode(error);});
});
// A tab can report loading for a child-frame navigation. Only a top-document
// navigation invalidates the whole session; frame refs are revalidated separately.
chrome.webNavigation.onBeforeNavigate.addListener(({tabId,frameId})=>{if(frameId!==0)return;const w=sessions.get(owners.get(tabId)??'');if(w?.session.binding?.tabId===tabId)w.session.invalidate(true,true);});
chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true}).catch(()=>{});
void ensureConnected().catch(()=>{});
