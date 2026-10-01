import { z } from 'zod';
import { HOST_NAME, PROTOCOL_VERSION, PilotError, safeCode, exactOrigin, profileSchema, type BrowserProfile } from '../shared.js';
import { createBrowserSession, type BrowserSession } from './session.js';

let native:chrome.runtime.Port|undefined,connecting:Promise<void>|undefined,profile:BrowserProfile;
const requests=new Map<string,{resolve:(data:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
type Workspace={session:BrowserSession;windowId?:number;groupId?:number;tabs:Set<number>;busy:boolean;closed:boolean};
const sessions=new Map<string,Workspace>(),owners=new Map<number,string>();
function workspace(id:string,name:string,external=false,windowId?:number){
  if(sessions.has(id))throw new PilotError('duplicate_session');if(sessions.size>=40)throw new PilotError('session_limit');
  const w:Workspace={session:createBrowserSession(id,name,external,(command,payload)=>host(command,payload,id)),tabs:new Set(),windowId,busy:false,closed:false};sessions.set(id,w);return w;
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
    profile=stored?profileSchema.parse(stored):{id:crypto.randomUUID(),name:'Profil '+crypto.randomUUID().slice(0,6),mcpEnabled:false};
    await chrome.storage.local.set({profile});
    native=chrome.runtime.connectNative(HOST_NAME);
    const port=native;
    native.onMessage.addListener(message=>{
      if(message?.event==='browser-command'){
        const reply=(value:unknown)=>{try{port.postMessage(value);}catch{/* Disconnected actions are never replayed on a new connection. */}};
        void dispatch(message.command,message.payload,'mcp').then(data=>reply({event:'browser-result',id:message.id,ok:true,data}),error=>reply({event:'browser-result',id:message.id,ok:false,code:safeCode(error)}));return;
      }
      const req=requests.get(message.id);if(!req)return;clearTimeout(req.timer);requests.delete(message.id);
      if(message.ok)req.resolve(message.data);else req.reject(new PilotError(message.code??'host_error'));
    });
    native.onDisconnect.addListener(()=>{
      void chrome.runtime.lastError;native=undefined;connecting=undefined;
      for(const w of sessions.values())w.session.invalidate(false);sessions.clear();owners.clear();
      for(const req of requests.values()){clearTimeout(req.timer);req.reject(new PilotError('native_host_unavailable'));}requests.clear();
      // No action is replayed. Reconnect only registers this profile again.
      setTimeout(()=>void ensureConnected().catch(()=>{}),3000);
    });
    await send('hello',profile);
    workspace('panel','Ruční úloha');
  })().catch(error=>{native?.disconnect();connecting=undefined;throw error;});
  return connecting;
}
async function host(command:string,payload?:unknown,sessionId='panel'){await ensureConnected();return send(command,payload,sessionId);}
function summary(w:Workspace){return {id:w.session.id,name:w.session.name,external:w.session.external,windowId:w.windowId,groupId:w.groupId,tabIds:[...w.tabs],binding:w.session.binding,busy:w.busy||w.session.busy};}
async function release(w:Workspace){
  w.closed=true;
  try{await w.session.release();}finally{for(const id of w.tabs)if(owners.get(id)===w.session.id)owners.delete(id);sessions.delete(w.session.id);}
  return {released:true,tabsClosed:false};
}
async function dispatch(name:string,input:any,source:'panel'|'mcp'):Promise<any>{
  await ensureConnected();
  if(source==='mcp'&&!profile.mcpEnabled&&name!=='session.release')throw new PilotError('mcp_access_disabled');
  if(name==='profile.update'){
    if(source!=='panel')throw new PilotError('forbidden');
    const next=profileSchema.parse({...profile,...input,id:profile.id});
    // Revoke locally before allowing any further remote commands.
    profile=next;await chrome.storage.local.set({profile});await host(name,{name:profile.name,mcpEnabled:profile.mcpEnabled});
    if(!profile.mcpEnabled)await Promise.allSettled([...sessions.values()].filter(w=>w.session.external).map(release));return profile;
  }
  if(name==='sessions.list')return [...sessions.values()].map(summary);
  if(name==='session.create'){
    const p=z.object({id:z.string().uuid().optional(),name:z.string().trim().min(1).max(80),windowId:z.number().int().nonnegative().optional()}).strict().parse(input);
    if(p.windowId!==undefined)await chrome.windows.get(p.windowId);
    return summary(workspace(p.id??crypto.randomUUID(),p.name,source==='mcp',p.windowId));
  }
  if(name==='tabs.list')return (await chrome.tabs.query({})).filter(t=>/^https?:/.test(t.url??'')).map(t=>({id:t.id,windowId:t.windowId,groupId:t.groupId,url:t.url,title:t.title,ownerSessionId:owners.get(t.id!)}));
  if(['configure','vault.unlock','vault.lock','vault.list','vault.put','vault.remove','vault.scope'].includes(name)){
    if(source==='mcp'&&name!=='vault.list')throw new PilotError('forbidden');
    if(name==='vault.lock')for(const w of sessions.values())w.session.invalidate();
    return host(name,input);
  }
  const {sessionId='panel',...payload}=input??{};
  const w=sessions.get(sessionId);if(!w||w.closed)throw new PilotError('unknown_session');
  if(source==='panel'&&w.session.external&&!['status','cancel','session.release'].includes(name))throw new PilotError('session_owned_by_mcp');
  if(source==='mcp'&&!w.session.external)throw new PilotError('session_not_owned');
  if(name==='status')return {...await w.session.invoke(name),profile,sessions:[...sessions.values()].map(summary)};
  if(name==='session.release')return release(w);
  if(name==='cancel')return w.session.invoke(name);
  if(w.busy)throw new PilotError('busy');w.busy=true;
  try{
    if(name==='tabs.open'){
      const p=z.object({url:z.string().url().max(2048),active:z.boolean().default(false)}).strict().parse(payload);exactOrigin(p.url);
      const tab=await chrome.tabs.create({url:p.url,active:p.active,windowId:w.windowId});const tabId=tab.id!;
      if(w.closed){return {tabId,opened:true,attached:false,code:'session_closed'};}
      w.tabs.add(tabId);owners.set(tabId,sessionId);w.windowId=tab.windowId;
      // Failure leaves the created tab visible and tracked; never retry creating it implicitly.
      try{
        if(w.groupId!==undefined){const group=await chrome.tabGroups.get(w.groupId).catch(()=>undefined);if(!group||group.windowId!==tab.windowId)w.groupId=undefined;}
        w.groupId=await chrome.tabs.group({tabIds:[tabId],...(w.groupId===undefined?{createProperties:{windowId:tab.windowId}}:{groupId:w.groupId})});
        await chrome.tabGroups.update(w.groupId,{title:w.session.name,color:'blue'});
        return {tabId,groupId:w.groupId,windowId:tab.windowId,opened:true,attached:false,next:'Wait for the page to load, grant site access if needed, then attach this tab.'};
      }catch{return {tabId,windowId:tab.windowId,opened:true,grouped:false,attached:false,code:'group_failed'};}
    }
    if(name==='pin'){
      const tabId=z.number().int().nonnegative().parse(payload.tabId),owner=owners.get(tabId);
      if(owner&&owner!==sessionId)throw new PilotError('tab_in_use');
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
  const w=sessions.get(owners.get(tabId)??'');if(w){w.tabs.delete(tabId);if(w.session.binding?.tabId===tabId)w.session.invalidate();}owners.delete(tabId);
});
chrome.tabs.onUpdated.addListener((tabId,change)=>{if(change.status==='loading'){const w=sessions.get(owners.get(tabId)??'');if(w?.session.binding?.tabId===tabId)w.session.invalidate();}});
chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true}).catch(()=>{});
void ensureConnected().catch(()=>{});
