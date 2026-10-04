import { PROVIDERS, providerNames, type BrowserProfile, type SecretScope, type ProviderId, type Snapshot, type VaultMetadata } from '../shared.js';
import { summarize, type BenchmarkRow } from '../benchmark.js';
import {FILE_CHUNK_BYTES,FILE_MAX_BYTES} from '../file-contract.js';
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const val=(id:string)=>$<HTMLInputElement>(id).value;
const node=(tag:string,text?:string,className?:string)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(className)n.className=className;return n;};
const option=(value:string,text:string)=>{const e=document.createElement('option');e.value=value;e.textContent=text;return e;};
// Chrome's options page exposes the existing technical tools; the side panel stays minimal.
const toolsView=new URLSearchParams(location.search).has('tools');
document.body.classList.toggle('tools',toolsView);
let permissionsReady=false,hasInputPermissions=false,statusPolling=false;
function renderConnectionSetup(){
  $('permission-setup').hidden=!permissionsReady||hasInputPermissions;
  $('mcp-paused').hidden=!profile||profile.mcpEnabled;
  $('connection-setup').hidden=['permission-setup','mcp-paused','profile-choice'].every(id=>$(id).hidden);
}
async function refreshPermissions(){
  hasInputPermissions=await chrome.permissions.contains({permissions:['debugger','downloads']});
  permissionsReady=true;renderConnectionSetup();
}
const permissionCheckFailed=()=>notice('Chrome nemohl ověřit oprávnění. Obnov panel; pokud chyba trvá, znovunačti Taboru ve správě rozšíření.');
chrome.permissions.onAdded.addListener(()=>void refreshPermissions().catch(permissionCheckFailed));
chrome.permissions.onRemoved.addListener(()=>void refreshPermissions().catch(permissionCheckFailed));
let tabs:chrome.tabs.Tab[]=[],lastRows:BenchmarkRow[]=[],table:string[][]=[];
let profile:BrowserProfile|undefined,selectedSession='panel',configs:any[]=[],catalogGeneration=0;
let profileCandidates:{key:string;name:string}[]=[];
let activeRun:{id:string;sessionId:string}|undefined;
let selectedFileRequest:string|undefined,uploadingFiles=false;
const panelFiles:{id:string;name:string;size:number;sessionId:string}[]=[];
let workflowFields:{field:string;section?:string;origin:string;kind:string;multiple?:boolean;options?:string[]}[]=[],workflowDocument:{sessionId:string;documentId:string}|undefined;
async function refreshFiles(){
  const requests=await rpc('files.requests');
  $('attachments').classList.toggle('has-requests',requests.length>0||panelFiles.length>0);
  $('file-requests').replaceChildren(...requests.map((r:any)=>{
    const box=node('div'),description=node('p',r.purpose),pick=node('button','Vybrat přílohu','secondary') as HTMLButtonElement,cancel=node('button','Zrušit','quiet') as HTMLButtonElement;
    pick.type=cancel.type='button';
    pick.addEventListener('click',()=>{if(uploadingFiles)return;selectedFileRequest=r.id;const input=$<HTMLInputElement>('file-picker');input.accept=r.accept;input.multiple=r.multiple;input.value='';input.click();});
    cancel.addEventListener('click',()=>void perform(async()=>{await rpc('files.cancel',{requestId:r.id});await refreshFiles();}));
    box.append(description,pick,cancel);return box;
  }));
  $('file-items').replaceChildren(...panelFiles.filter(file=>file.sessionId===selectedSession).map(f=>{const item=node('li',`${f.name} · ${f.size} B`),remove=node('button','Odebrat','quiet') as HTMLButtonElement;remove.type='button';remove.addEventListener('click',()=>void perform(async()=>{await rpc('files.release',{artifactIds:[f.id]});panelFiles.splice(panelFiles.indexOf(f),1);await refreshFiles();}));item.append(remove);return item;}));
}
  async function receiveFiles(files:File[],requestId?:string){
    if(!files.length){if(requestId)await rpc('files.cancel',{requestId});await refreshFiles();return;}
    if(uploadingFiles)throw new Error('busy');if(files.some(f=>f.size>FILE_MAX_BYTES))throw new Error('file_size_limit');
    uploadingFiles=true;controls();const ids:string[]=[],staged:string[]=[];
  try{
    for(const file of files){
      notice(`Přijímám ${file.name}…`);
        const {transferId}=await rpc('files.begin',{name:file.name,size:file.size,mime:file.type||'application/octet-stream',...(requestId?{requestId}:{})});
        staged.push(transferId);
      let offset=0;
      while(offset<file.size){const bytes=new Uint8Array(await file.slice(offset,offset+FILE_CHUNK_BYTES).arrayBuffer());let raw='';for(const b of bytes)raw+=String.fromCharCode(b);await rpc('files.chunk',{transferId,offset,data:btoa(raw),...(requestId?{requestId}:{})});offset+=bytes.length;}
      const meta=await rpc('files.finish',{transferId,...(requestId?{requestId}:{})});ids.push(meta.id);
      if(!requestId)panelFiles.push({...meta,sessionId:selectedSession});
    }
    if(requestId&&ids.length)await rpc('files.fulfill',{requestId,artifactIds:ids});
      notice(requestId?'Příloha předaná agentovi.':'Přílohy připravené v tomto profilu.',true);
    }catch(error){
      try{if(requestId)await rpc('files.cancel',{requestId});else if(staged.length)await rpc('files.release',{artifactIds:staged});}
      catch{throw new Error('file_cleanup_failed');}
      for(let i=panelFiles.length-1;i>=0;i--)if(staged.includes(panelFiles[i].id))panelFiles.splice(i,1);
      throw error;
    }finally{uploadingFiles=false;controls();}
    await refreshFiles();
  }
$('add-file').addEventListener('click',()=>{if(uploadingFiles)return;selectedFileRequest=undefined;const input=$<HTMLInputElement>('file-picker');input.accept='';input.multiple=true;input.value='';input.click();});
$('file-picker').addEventListener('change',()=>{const files=Array.from($<HTMLInputElement>('file-picker').files??[]),requestId=selectedFileRequest;selectedFileRequest=undefined;void perform(()=>receiveFiles(files,requestId));});
$('file-picker').addEventListener('cancel',()=>{const requestId=selectedFileRequest;selectedFileRequest=undefined;if(requestId)void perform(async()=>{await rpc('files.cancel',{requestId});await refreshFiles();});});
$('refresh-files').addEventListener('click',()=>void perform(refreshFiles));
$('attachments').addEventListener('dragover',e=>{e.preventDefault();});
$('attachments').addEventListener('drop',e=>{e.preventDefault();const files=Array.from((e as DragEvent).dataTransfer?.files??[]);if(files.length)void perform(()=>receiveFiles(files));});
async function pollStatus(){
  if(document.hidden||statusPolling)return;
  statusPolling=true;
  try{
    const reconnect=!$('connection-dot').classList.contains('online');
    renderStatus(await rpc('status'));
    if(reconnect)await perform(async()=>{await synchronizeProvider();await detectProfile();$('notice').hidden=true;});
    if(!uploadingFiles)await refreshFiles();
  }
  catch{$('connection').textContent='Připojení přerušeno · zkus Obnovit';$('connection-dot').classList.remove('online');}
  finally{statusPolling=false;}
}
setInterval(()=>void pollStatus(),5000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void pollStatus();});
const scopedCommands=new Set(['status','pin','observe','decide','manual','execute','cancel','benchmark','tabs.open','session.release','run.start','run.status','run.cancel','v2.state','v2.resume','files.begin','files.chunk','files.finish','files.release']);
function secretScope(value:string):SecretScope {if(value==='shared')return {type:'shared'};if(!profile)throw new Error('profile_required');return {type:'profile',profileId:profile.id};}
const errors:Record<string,string>={native_host_unavailable:'Lokální host není dostupný. Spusť scripts/install-host.ps1 podle README a obnov spojení.',vault_locked:'Nejprve odemkni vault.',missing_api_key:'U poskytovatele chybí API klíč.',missing_model:'Vyber model poskytovatele.',decisions_preview_unavailable:'Decisions API: čeká se na ověřenou preview specifikaci.',observe_first:'Připoj stránku a načti její prvky.',no_bound_tab:'Nejprve připoj konkrétní stránku.',no_candidates:'Na stránce nebyl nalezen podporovaný cíl.',stale_snapshot:'Stránka nebo cílový prvek se změnil. Znovu načti prvky.',stale_binding:'Dokument se změnil. Připoj stránku znovu.',credential_scope_mismatch:'Účet neodpovídá přesnému HTTPS originu stránky.',ambiguous_login_form:'Přihlašovací formulář není jednoznačný. Tento případ dokonči ručně.',partial_write:'Formulář se při vyplňování změnil. Zkontroluj částečně vyplněná pole.',navigation_out_of_scope:'Cíl vede na jiný origin. Novou stránku otevři a připoj samostatně.',decision_expired:'Návrh akce už neplatí. Připrav nový.',cancelled:'Úloha byla zastavena.',timeout:'Poskytovatel překročil časový limit.',unexpected_tools:'SDK zpřístupnilo neočekávané nástroje. Rozhodnutí bylo odmítnuto.',tool_call_blocked:'Pokus SDK použít nástroj byl zablokován.',provider_failed:'Poskytovatel selhal. Zkontroluj model a přístup; citlivý výstup se nezobrazuje.',authentication_failed:'Poskytovatel odmítl přihlášení. Zkontroluj API klíč.',site_permission_required:'Chrome nepovolil přístup k tomuto webu. Zkontroluj oprávnění Tabory v nastavení rozšíření.',select_credential:'Vyber účet z vaultu.',browser_error:'Browser operace selhala. Připoj stránku znovu; nepodporované stránky a iframy ovládni ručně.'};
function notice(text:string,success=false){$('notice').hidden=false;$('notice').textContent=text;$('notice').className=success?'success':'';}
Object.assign(errors,{
  background_cleanup_failed:'Akce mohla proběhnout, ale Chrome neuvolnil spojení s tabem. Zkontroluj stav stránky a uvolni debugger; zapisující akci neopakuj naslepo.',
  background_debugger_unavailable:'Tab ovládá jiný debugger. Uvolni ho před další akcí; Tabora nepřebírá cizí spojení.',background_emulation_unavailable:'Chrome nepodporuje emulaci aktivní stránky pro tento tab. Akce nebyla spuštěna.',background_rendering_unavailable:'Chrome nemůže připravit vykreslování tabu na pozadí. Akce nebyla spuštěna.',background_interrupted:'Ovládání tabu na pozadí bylo přerušeno. Načti nové pozorování a zkontroluj stav stránky.',
  native_input_permission_required:'Znovunačti Taboru ve správě rozšíření a potvrď případný souhlas Chrome.',capture_permission_required:'Znovunačti Taboru ve správě rozšíření a potvrď případný souhlas Chrome.',provider_vision_unsupported:'Zvolený poskytovatel nebo model nemá ověřený obrazový vstup. Vyber Codex nebo Claude SDK pro obraz.',missing_visual_model:'U poskytovatele pro obraz nejprve připoj SDK a vyber model.',stale_capture:'Obraz stránky už není aktuální. Pořiď nové pozorování; nejistou zapisující akci neopakuj.',
  native_host_not_registered:'Chrome nenalezl registraci lokálního hostu (native_host_not_registered). Spusť scripts/install-host.ps1 z tohoto repozitáře.',
  native_host_forbidden:'Chrome zakázal přístup k lokálnímu hostu (native_host_forbidden). Zkontroluj ID rozšíření v allowed_origins a zásady prohlížeče.',
  native_host_start_failed:'Chrome našel host, ale nemůže spustit jeho proces (native_host_start_failed). Zkontroluj spouštěč host.cmd, instalaci Node.js a oprávnění ke spuštění.',
  native_host_exited:'Chrome spustil host, ale proces předčasně skončil (native_host_exited). Je potřeba ověřit chybu při startu hostu.',
  host_update_required:'Host a rozšíření používají rozdílný protokol. Aktualizuj lokální host a znovu načti rozšíření na chrome://extensions.',
  native_host_protocol_error:'Spojení s hostem selhalo při přenosu zpráv (native_host_protocol_error). Je potřeba ověřit formát zpráv a výstup spouštěče.'
});
Object.assign(errors,{tab_in_use:'Tab už používá jiná relace. Nejprve ji uvolni.',session_owned_by_mcp:'Tuto relaci ovládá MCP klient. Můžeš ji zastavit nebo uvolnit.',scope_conflict:'V cílové dostupnosti už existuje klíč pro tohoto poskytovatele. Nejdříve rozhodni, který zachovat.',profile_scope_mismatch:'Položka patří jinému profilu.',unknown_session:'Relace skončila. Obnov seznam relací.',mcp_access_disabled:'Pro tento profil není povolen přístup přes MCP.',busy:'V této relaci právě probíhá jiný krok.'});
Object.assign(errors,{no_progress:'Model opakoval stejné kroky bez postupu. Úloha byla zastavena.',step_limit:'Úloha dosáhla limitu kroků.',ask_user:'Model potřebuje doplnit údaj nebo povolení od uživatele.',run_active:'V této relaci už běží úloha. Nejdříve ji zastav.',decision_provider_required:'Pro lokální úlohu vyber poskytovatele a model.',provider_preference_mismatch:'Poskytovatel neodpovídá aktuální volbě profilu.',action_outcome_unknown:'Výsledek akce není jistý. Zkontroluj stránku; akce se automaticky neopakuje.'});
async function rpc(command:string,payload?:any):Promise<any>{const r=await chrome.runtime.sendMessage({command,payload:scopedCommands.has(command)?{...payload,sessionId:selectedSession}:payload});if(!r?.ok)throw new Error(r?.code??'native_host_unavailable');return r.data;}
async function perform(fn:()=>Promise<void>){for(const b of document.querySelectorAll<HTMLButtonElement>('.when-idle'))b.disabled=true;try{await fn();}catch(e){const code=e instanceof Error?e.message:'internal_error';notice(errors[code]??code);}finally{for(const b of document.querySelectorAll<HTMLButtonElement>('.when-idle'))b.disabled=false;controls();}}
function click(id:string,fn:()=>Promise<void>){$(id).addEventListener('click',()=>void perform(fn));}
function saveDownload(name:string,content:string,type:string){const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
for(const p of PROVIDERS)$('provider').append(option(p,providerNames[p]));
$('settings-toggle').onclick=()=>{const open=$('settings').hidden;$('settings').hidden=!open;$('settings-toggle').setAttribute('aria-expanded',String(open));if(open){$('settings').scrollIntoView({block:'start'});void perform(detectProfile);}};
function controls(){
  const agent=val('provider')==='agent',mode=profile?.mode??'safe';
  $('existing-tabs').hidden=mode==='safe';$('vault').hidden=!profile?.vaultEnabled;$('provider-key-fields').hidden=val('provider-connection')!=='vault'||!profile?.vaultEnabled;
  $('decide').toggleAttribute('disabled',agent||!val('model'));
  $('run-start').toggleAttribute('disabled',agent||!val('model')||!!activeRun);
  $<HTMLSelectElement>('session').disabled=!!activeRun||uploadingFiles;
  $<HTMLSelectElement>('run-mode').options[1].disabled=mode==='readonly';if(mode==='readonly')$<HTMLSelectElement>('run-mode').value='read';$('workflow-settings').hidden=val('run-mode')!=='action';
  const recipe=$<HTMLSelectElement>('recipe');for(const opt of recipe.options)opt.disabled=(mode==='readonly'&&opt.value!=='extract')||(opt.value==='login'&&!profile?.vaultEnabled);
  if(recipe.selectedOptions[0]?.disabled){recipe.value='extract';recipeChanged();}
}
function resetPage(){for(const id of ['preview','snapshot-box','outcome'])$(id).hidden=true;}
async function updateProfile(patch:Partial<BrowserProfile>){profile=await rpc('profile.update',patch);resetPage();await refresh();$('notice').hidden=true;}
async function detectProfile(){
  const result=await rpc('profile.detect',{browser:/Edg\//.test(navigator.userAgent)?'edge':'chrome',key:profile?.browserProfileKey});profileCandidates=result.candidates;
  $('profile-choice').hidden=profileCandidates.length<2||!!profile?.browserProfileKey;
  $('browser-profile').replaceChildren(option('','Vyber profil'),...profileCandidates.map(p=>option(p.key,p.name)));
  $<HTMLSelectElement>('browser-profile').value=profile?.browserProfileKey??'';
  renderConnectionSetup();
}
function renderProvider(){
  const p=val('provider'),agent=p==='agent';$('provider-connect').hidden=agent;$('agent-hint').hidden=!agent;$('provider-settings').hidden=agent;
  if(agent){$('model').replaceChildren(option('','Vybírá připojený agent'));$<HTMLSelectElement>('model').disabled=true;controls();return;}
  const config=configs.find(c=>c.provider===p),connection=config?.connection??(p==='codex-sdk'||p==='claude-sdk'?'sdk':'environment');
  const choices=p==='codex-sdk'||p==='claude-sdk'?[option('sdk','Lokální přihlášení · SDK'),option('vault','API klíč · vault')]:[option('environment','Systémové prostředí'),option('vault','API klíč · vault')];
  $('provider-connection').replaceChildren(...choices);$<HTMLSelectElement>('provider-connection').value=connection;
  $('provider-key-fields').hidden=connection!=='vault'||!profile?.vaultEnabled;
  $('connect-provider').textContent='Zkusit znovu';$('connect-provider').hidden=!toolsView;
  $('provider-state').textContent=p==='openai-decisions'?'Decisions API zatím není dostupné.':connection==='sdk'?'Použije lokální přihlášení.':connection==='vault'?'Vyžaduje zapnutý a odemčený vault.':'Použije klíč ze systémového prostředí.';
  $('model').replaceChildren(option('','Připoj poskytovatele'));$<HTMLSelectElement>('model').disabled=true;controls();
}
async function loadModels(refresh=false,saveSelection=true){
  const provider=val('provider');if(provider==='agent')return;
  const generation=++catalogGeneration,connection=val('provider-connection');$('provider-state').textContent='Načítám katalog modelů…';$('model').replaceChildren(option('','Načítám modely…'));$<HTMLSelectElement>('model').disabled=true;controls();
  $('connect-provider').hidden=!toolsView;
  let result;
  try{result=await rpc('provider.catalog',{provider,connection,refresh});}
  catch(error){
    if(generation===catalogGeneration){$('provider-state').textContent=errors[error instanceof Error?error.message:'provider_failed']??'Připojení poskytovatele selhalo.';$('model').replaceChildren(option('','Poskytovatel není připojený'));$('connect-provider').hidden=false;}
    throw error;
  }
  if(generation!==catalogGeneration||provider!==val('provider')||connection!==val('provider-connection'))return;
  const labels:Record<string,string>={connected:'Připojeno · katalog SDK',login_required:'Nejprve se přihlas v lokálním Codex / Claude klientu.',missing_api_key:'Chybí klíč v systémovém prostředí.',preview_unavailable:'Decisions API zatím není dostupné.',configured_unverified:'Nastaveno · přístup ověří první rozhodnutí'};
  $('provider-state').textContent=result.source==='account'?'Připojeno · modely účtu':labels[result.state]??result.state;
  $('connect-provider').hidden=!toolsView&&['connected','configured_unverified','preview_unavailable'].includes(result.state);
  $('model').replaceChildren(...(result.models.length?result.models.map((m:any)=>option(m.id,m.label)):[option('','Žádné dostupné modely')]));
  $<HTMLSelectElement>('model').disabled=!result.models.length;
  const config=configs.find(c=>c.provider===provider),chosen=result.models.find((m:any)=>m.id===config?.model)??(saveSelection?(result.models.find((m:any)=>m.isDefault)??result.models[0]):undefined);
  $<HTMLSelectElement>('model').value=chosen?.id??'';
  if(chosen&&saveSelection)await saveModel();controls();
}
async function synchronizeProvider(saveSelection=true){
  $<HTMLSelectElement>('provider').value=profile?.activeProvider??'agent';
  renderProvider();if(val('provider')!=='agent')await loadModels(false,saveSelection);
}
chrome.runtime.onMessage.addListener((message,sender)=>{
  if(sender.id!==chrome.runtime.id||message?.event!=='provider.settings.changed')return;
  catalogGeneration++;
  void perform(async()=>{await refresh();$<HTMLSelectElement>('provider').value=profile?.activeProvider??'agent';renderProvider();if(val('provider')!=='agent')await loadModels(false,false);});
});
async function saveModel(){
  if(val('provider')==='agent'||!val('model'))return;
  const config={provider:val('provider'),model:val('model'),connection:val('provider-connection'),timeoutMs:configs.find(c=>c.provider===val('provider'))?.timeoutMs??30000};
  if(JSON.stringify(config)===JSON.stringify(configs.find(c=>c.provider===config.provider)))return;
  const state=await rpc('configure',config);configs=state.configs;
}
$('browser-profile').addEventListener('change',()=>void perform(async()=>{const p=profileCandidates.find(p=>p.key===val('browser-profile'));if(p)await updateProfile({name:p.name,browserProfileKey:p.key,nameSource:'selected'});}));
for(const radio of document.querySelectorAll<HTMLInputElement>('input[name=mode]'))radio.addEventListener('change',()=>void perform(()=>updateProfile({mode:radio.value as BrowserProfile['mode']})));
$('vault-enabled').addEventListener('change',()=>void perform(()=>updateProfile({vaultEnabled:$<HTMLInputElement>('vault-enabled').checked})));
$('mcp-enabled').addEventListener('change',()=>void perform(()=>updateProfile({mcpEnabled:$<HTMLInputElement>('mcp-enabled').checked})));
// Required permissions cannot be granted by permissions.request(). Chrome owns
// installation/update consent; this button only opens its extension manager.
click('enable-input',async()=>{await chrome.tabs.create({url:`chrome://extensions/?id=${chrome.runtime.id}`});});
click('resume-mcp',()=>updateProfile({mcpEnabled:true}));
$('provider').addEventListener('change',()=>void perform(async()=>{catalogGeneration++;await updateProfile({activeProvider:val('provider') as BrowserProfile['activeProvider']});renderProvider();if(val('provider')!=='agent')await loadModels();}));
$('provider-connection').addEventListener('change',()=>void perform(async()=>{catalogGeneration++;$('provider-key-fields').hidden=val('provider-connection')!=='vault'||!profile?.vaultEnabled;await loadModels();}));
$('model').addEventListener('change',()=>void perform(saveModel));
click('connect-provider',()=>loadModels(true));
click('save-provider-key',async()=>{const secret=val('provider-key');$<HTMLInputElement>('provider-key').value='';await rpc('vault.put',{kind:'provider',provider:val('provider'),secret,scope:secretScope(val('provider-key-scope'))});await loadModels(true);notice('Klíč uložený do vaultu.',true);});
function recipeChanged(){const r=val('recipe');$('fields-group').hidden=r!=='fill';$('credential-group').hidden=r!=='login';$('preview').hidden=true;}
$('recipe').addEventListener('change',recipeChanged);
function showSnapshot(s:Snapshot){
  $('snapshot-box').hidden=false;$('snapshot-info').textContent=`${s.targets.length} cílů · ${s.origin} · pouze hlavní dokument`;
  $('targets').replaceChildren(...s.targets.map(t=>node('li',`${t.id} · ${t.name}`)));
  $('manual-target').replaceChildren(...s.targets.map(t=>option(t.id,t.name)));
  $('expected').replaceChildren(option('','Bez hodnocení správnosti'),...s.targets.map(t=>option(t.id,t.name)),option('ask_user','Předat uživateli'));
}
function showVault(entries:VaultMetadata[]){
  $('credential').replaceChildren(option('','Vyber účet'),...entries.filter(e=>e.kind==='website').map(e=>option(e.id,`${e.label} · ${e.origin}`)));
  $('vault-items').replaceChildren(...entries.map(e=>{
    const row=node('div',undefined,'vault-row'),description=node('div',e.label);description.append(node('small',e.origin??'API credential'),node('small',e.scope.type==='shared'?'Sdílený mezi profily':'Jen tento profil'));
    const scopeSelect=document.createElement('select');scopeSelect.setAttribute('aria-label',`Dostupnost: ${e.label}`);scopeSelect.append(option('profile','Jen tento profil'),option('shared','Sdílený'));scopeSelect.value=e.scope.type;
    const change=node('button','Změnit dostupnost','quiet') as HTMLButtonElement;change.onclick=()=>void perform(async()=>{showVault(await rpc('vault.scope',{id:e.id,scope:secretScope(scopeSelect.value)}));notice('Dostupnost položky změněna.',true);});
    const button=node('button','Odstranit','quiet') as HTMLButtonElement;button.onclick=()=>void perform(async()=>{if(!confirm(`Odstranit položku ${e.label}?`))return;showVault(await rpc('vault.remove',{id:e.id}));await refresh();});
    const controls=node('div',undefined,'vault-controls');controls.append(scopeSelect,change,button);row.append(description,controls);return row;
  }));
}
function renderStatus(state:any){
  if(state.profile){profile=state.profile;$('profile-label').textContent=profile!.name;$<HTMLInputElement>('mcp-enabled').checked=profile!.mcpEnabled;$<HTMLInputElement>('vault-enabled').checked=profile!.vaultEnabled??false;$('profile-id').textContent='ID profilu: '+profile!.id;
    for(const r of document.querySelectorAll<HTMLInputElement>('input[name=mode]'))r.checked=r.value===(profile!.mode??'safe');
    const descriptions={safe:'Agent otevírá nové taby ve vlastní skupině v existujícím okně. Přihlášení webů sdílí s tímto profilem.',takeover:'Agent může připojit existující tab a provádět v něm akce.',readonly:'Agent může číst existující stránky. Klikání a vyplňování je zablokované.'};
    $('mode-description').textContent=descriptions[profile!.mode??'safe'];
  }
  if(state.sessions){$('session').replaceChildren(...state.sessions.map((s:any)=>option(s.id,s.name+(s.external?' · MCP':''))));$<HTMLSelectElement>('session').value=selectedSession;
    const external=state.sessions.filter((s:any)=>s.external);$('session-count').textContent=external.length?external.length+' připojených úloh':'Připraveno pro agenta';$('active-sessions').hidden=!toolsView&&!external.length&&!activeRun;}
  $('connection').textContent='Lokální host připojený';$('connection-dot').classList.add('online');
  $('vault-state').textContent=state.locked?'Vault je pro tento profil zamčený.':'Vault je odemčený pro tento profil.';if(state.locked||!profile?.vaultEnabled)showVault([]);
  $('bound').textContent=state.binding?'Připojeno: '+state.binding.origin+' · tab '+state.binding.tabId:'Otevři nebo připoj stránku.';
  configs=state.configs??configs;controls();renderConnectionSetup();
}
async function refresh(){
  try{const available=await rpc('sessions.list');if(!available.some((s:any)=>s.id===selectedSession))selectedSession=available[0]?.id??'panel';const state=await rpc('status');renderStatus(state);if(!state.locked&&profile?.vaultEnabled)showVault(await rpc('vault.list'));}catch(e){$('connection').textContent='Lokální host není dostupný';$('connection-dot').classList.remove('online');throw e;}
  tabs=await rpc('tabs.list');
  const previous=val('tab');$('tab').replaceChildren(...tabs.map(t=>option(String(t.id),t.title||new URL(t.url!).hostname)));if(tabs.some(t=>String(t.id)===previous))$<HTMLSelectElement>('tab').value=previous;
}
function inputs(){return {recipe:val('recipe'),fields:val('recipe')==='fill'?JSON.parse(val('fields')):undefined,credentialId:val('recipe')==='login'?(val('credential')||undefined):undefined};}
function preview(result:any){
  if(result.result?.status==='failed')throw new Error(result.result.code);
  $('preview').hidden=!result.canExecute;
  if(!result.canExecute){notice('Poskytovatel doporučuje doplnění nebo ruční zásah.');return;}
  $('preview-title').textContent=result.target.name;
  $('preview-info').textContent=result.manual?'Ruční zkušební volba. Model nebyl volán.':`${providerNames[result.result.provider as ProviderId]} · ${result.result.model} · ${result.result.latencyMs} ms`;
  if(val('recipe')==='fill')$('preview-info').textContent+='\n'+val('fields');
}
for(const id of ['goal','fields','credential','provider','recipe'])$(id).addEventListener('input',()=>{$('preview').hidden=true;});
click('refresh',async()=>{await refresh();await synchronizeProvider();await detectProfile();await refreshPermissions();await refreshFiles();});
$('session').addEventListener('change',()=>void perform(async()=>{selectedSession=val('session');$('preview').hidden=true;$('snapshot-box').hidden=true;$('outcome').hidden=true;await refresh();}));
click('session-create',async()=>{const s=await rpc('session.create',{name:val('session-name')||'Nová úloha'});selectedSession=s.id;await refresh();notice('Relace založena. Skupina vznikne otevřením prvního odkazu.',true);});
click('session-release',async()=>{await rpc('session.release');const s=await rpc('session.create',{name:'Ruční úloha'});selectedSession=s.id;await refresh();notice('Relace uvolněna. Taby zůstaly otevřené.',true);});
click('open-tab',async()=>{
  const result=await rpc('tabs.open',{url:val('open-url'),active:false,waitForReady:true});
  if(!result.attached)throw new Error(result.code??'page_loading');resetPage();await refresh();notice('Stránka otevřená a připojená.',true);
});
click('run-start',async()=>{
  if(!val('run-goal').trim())throw new Error('Zadej úlohu.');
  if(val('run-mode')==='action'&&(!workflowDocument||workflowDocument.sessionId!==selectedSession))throw new Error('Nejdřív připrav stránku a načti její pole.');
  if(val('run-mode')==='read'&&val('run-url')){
    const session=await rpc('session.create',{name:val('run-goal').slice(0,80)});selectedSession=session.id;
    const opened=await rpc('tabs.open',{url:val('run-url'),active:false,waitForReady:true});if(!opened.attached)throw new Error(opened.code??'page_loading');
  }
  let workflow;
  if(val('run-mode')==='action'){
    const status=await rpc('status');if(status.binding?.documentId!==workflowDocument?.documentId)throw new Error('Stránka se změnila. Znovu načti pole.');
    if(!val('workflow-success')||!val('workflow-confirmation').trim())throw new Error('Vyber místo a text potvrzení dokončení.');
    const values=Array.from($('workflow-values').children).map(row=>{const source=JSON.parse(row.querySelector<HTMLSelectElement>('select')!.value),boolean=['checkbox','radio','switch'].includes(source.kind),choice=row.querySelector<HTMLSelectElement>('[data-options]')!;return {field:source.field,section:source.section,origin:source.origin,value:boolean?row.querySelector<HTMLSelectElement>('[data-checked]')!.value==='true':source.options?source.multiple?Array.from(choice.selectedOptions).map(option=>option.value):choice.value:row.querySelector<HTMLInputElement>('input')!.value};});
    const attachments=val('workflow-file')?[{...JSON.parse(val('workflow-file')),artifactIds:panelFiles.filter(file=>file.sessionId===selectedSession).map(file=>file.id)}]:[];if(attachments.length&&!attachments[0].artifactIds.length)throw new Error('Připrav přílohu nebo zvol Bez přílohy.');
    workflow={values,attachments,success:{...JSON.parse(val('workflow-success')),contains:val('workflow-confirmation').trim()},visual:$<HTMLInputElement>('workflow-visual').checked?{provider:val('vision-provider')||undefined}:undefined};
  }
  const run=await rpc('run.start',{goal:val('run-goal'),workflow});activeRun={id:run.id,sessionId:selectedSession};
  $('run-output').hidden=false;$('run-output').textContent='Úloha běží…';await refresh();void pollRun(activeRun);
});
$('run-mode').addEventListener('change',controls);
$('vision-provider').addEventListener('change',()=>void chrome.storage.local.set({visionProvider:val('vision-provider')}));
void chrome.storage.local.get('visionProvider').then(value=>{if(typeof value.visionProvider==='string'&&['codex-sdk','claude-sdk'].includes(value.visionProvider))$<HTMLSelectElement>('vision-provider').value=value.visionProvider;});
click('workflow-load',async()=>{
  if(val('run-url')){const session=await rpc('session.create',{name:val('run-goal').slice(0,80)||'Nová úloha'});selectedSession=session.id;await rpc('tabs.open',{url:val('run-url'),active:true,waitForReady:true});await refreshFiles();}
  let state=await rpc('v2.state',{frameId:0,cursor:0,limit:100});const targets=[...state.snapshot.targets];for(let page=1;state.snapshot.coverage.nextCursor!==null&&page<10;page++){state=await rpc('v2.state',{frameId:0,cursor:state.snapshot.coverage.nextCursor,limit:100});targets.push(...state.snapshot.targets);}state.snapshot.targets=targets;workflowDocument={sessionId:selectedSession,documentId:state.binding.documentId};
  for(const target of targets.filter(target=>target.optionCount>40)){for(let offset=40;offset<Math.min(target.optionCount,1000);){const chunk=await rpc('v2.read',{frameId:0,targetId:target.id,format:'options',offset,limit:100});target.options.push(...chunk.options);if(chunk.nextOffset===null)break;if(chunk.nextOffset<=offset)throw new Error('reader_no_progress');offset=chunk.nextOffset;}}
  workflowFields=state.snapshot.targets.filter((target:any)=>target.name&&!target.secret&&!target.disabled&&['textbox','spinbutton','slider','checkbox','radio','switch','combobox','listbox'].includes(target.kind)).map((target:any)=>({field:target.name,section:target.section,origin:state.binding.origin,kind:target.kind,multiple:target.multiple,options:target.options?.filter((option:any)=>!option.disabled).map((option:any)=>option.label)}));
  $('workflow-values').replaceChildren();$<HTMLButtonElement>('workflow-add').disabled=!workflowFields.length;
  $('workflow-file').replaceChildren(option('','Bez přílohy'),...state.snapshot.targets.filter((target:any)=>target.kind==='file'&&target.name&&!target.disabled).map((target:any)=>option(JSON.stringify({field:target.name,section:target.section,origin:state.binding.origin}),target.name)));
  $('workflow-success').replaceChildren(option('','Vyber potvrzení'),...state.snapshot.targets.filter((target:any)=>target.name&&!target.secret&&['status','region','main','generic','alert'].includes(target.kind)).map((target:any)=>option(JSON.stringify({name:target.name,section:target.section,origin:state.binding.origin}),target.name.slice(0,100))));await refresh();notice('Stránka připravená. Vyber hodnoty a potvrzení dokončení.',true);
});
$('workflow-add').addEventListener('click',()=>{
  if(!workflowFields.length||$('workflow-values').children.length>=20)return;
  const row=node('div','', 'surface'),label=node('label','Pole'),field=document.createElement('select'),input=document.createElement('input'),checked=document.createElement('select'),choices=document.createElement('select'),remove=node('button','Odebrat hodnotu','quiet') as HTMLButtonElement;
  field.setAttribute('aria-label','Pole úlohy');input.setAttribute('aria-label','Hodnota pole');checked.setAttribute('aria-label','Požadovaný stav');field.append(...workflowFields.map(source=>option(JSON.stringify(source),source.field+(source.section?' · '+source.section:''))));checked.append(option('true','Zapnuto / vybráno'),option('false','Vypnuto'));input.type='text';input.maxLength=16000;remove.type='button';remove.onclick=()=>row.remove();
  checked.dataset.checked='true';choices.dataset.options='true';choices.setAttribute('aria-label','Požadované možnosti');
  const update=()=>{const source=JSON.parse(field.value),boolean=['checkbox','radio','switch'].includes(source.kind);input.hidden=boolean||!!source.options;checked.hidden=!boolean;choices.hidden=!source.options;choices.multiple=!!source.multiple;choices.size=source.multiple?Math.min(6,source.options?.length??1):1;choices.replaceChildren(...(source.options??[]).map((value:string)=>option(value,value)));};field.onchange=update;row.append(label,field,input,checked,choices,remove);$('workflow-values').append(row);update();
});
async function pollRun(run:{id:string;sessionId:string}){
  try{
    const reply=await chrome.runtime.sendMessage({command:'run.status',payload:{sessionId:run.sessionId,runId:run.id}});
    if(!reply?.ok)throw new Error(reply?.code??'native_host_unavailable');
    const state=reply.data;
    $('run-resume').hidden=state.status!=='needs_input'||selectedSession!==run.sessionId;
    $('run-output').textContent=state.status==='running'?`Krok ${state.steps} · ${(state.elapsedMs/1000).toFixed(1)} s`:state.status==='completed'?`${state.answer}\n${state.evidence?.section??''} · ${state.evidence?.description??''}\n${(state.elapsedMs/1000).toFixed(1)} s · ${state.steps} rozhodnutí`:`Úloha skončila: ${errors[state.code]??state.code??state.status}`;
    if(state.status==='running'){setTimeout(()=>void pollRun(run),500);return;}
  }catch(error){$('run-output').textContent=errors[(error as Error).message]??(error as Error).message;}
  if(activeRun?.id===run.id)activeRun=undefined;controls();
}
click('run-resume',async()=>{const resumed=await rpc('v2.resume');workflowDocument={sessionId:selectedSession,documentId:resumed.binding.documentId};$('run-resume').hidden=true;await refresh();notice('Připojení obnovené. Spuštěním úlohy se nejdřív ověří její aktuální výsledek.',true);});
click('pin',async()=>{
  const tab=tabs.find(t=>String(t.id)===val('tab'));if(!tab?.url)throw new Error('no_bound_tab');
  const b=await rpc('pin',{tabId:tab.id});$('bound').textContent=`Připojeno: ${b.origin} · tab ${b.tabId}`;$('preview').hidden=true;notice('Stránka připojena. Načti její prvky.',true);
});
click('observe',async()=>{const r=await rpc('observe',{recipe:val('recipe')});showSnapshot(r.snapshot);$('preview').hidden=true;notice('Prvky načtené. Hodnoty formuláře se neposílají modelu.',true);});
click('decide',async()=>preview(await rpc('decide',{provider:val('provider'),question:val('goal'),...inputs()})));
click('manual',async()=>preview(await rpc('manual',{targetId:val('manual-target'),...inputs()})));
click('execute',async()=>{
  $('preview').hidden=true;const result=await rpc('execute');$('outcome').hidden=false;$('outcome-text').textContent=JSON.stringify(result,null,2);
  table=result.rows??[];$('export-table').hidden=!table.length;
  notice(result.dispatched?'Klik byl odeslán. Výsledek na webu ověř ručně; automaticky se neopakuje.':'Výsledek lokálního kroku byl ověřen.',true);
});
async function stop(){await rpc('cancel');$('preview').hidden=true;notice('Další kroky zastaveny. Již odeslanou akci nelze vzít zpět.');}
click('stop',async()=>{const sessions=await rpc('sessions.list');await Promise.all(sessions.map((s:any)=>chrome.runtime.sendMessage({command:'cancel',payload:{sessionId:s.id}}).then((r:any)=>{if(!r?.ok)throw new Error(r?.code??'native_host_unavailable');})));resetPage();notice('Všechny úlohy v tomto profilu byly zastaveny.',true);});click('benchmark-stop',stop);
click('unlock',async()=>{const s=await rpc('vault.unlock');renderStatus(s);showVault(s.entries);notice('Vault odemčený.',true);});
click('lock',async()=>{renderStatus(await rpc('vault.lock'));showVault([]);});
$('vault-form').addEventListener('submit',e=>{e.preventDefault();void perform(async()=>{
  const payload={kind:'website',label:val('vault-label'),origin:val('vault-origin'),username:val('vault-user'),secret:val('vault-password'),scope:secretScope(val('vault-scope'))};$<HTMLInputElement>('vault-password').value='';
  const state=await rpc('vault.put',payload);showVault(state.entries);notice('Účet uložený. Heslo se nezobrazuje v seznamu.',true);
});});
function benchmarkResults(rows:BenchmarkRow[]){lastRows=rows;const summary=summarize(rows);$('export-results').hidden=!rows.length;
  $('benchmark-cards').replaceChildren(...summary.map(s=>{
    const card=node('div',undefined,'result');card.append(node('h3',providerNames[s.provider]),node('div',s.p50===null?'—':`${s.p50} ms`,'metric'),node('p','p50 platné odpovědi'),node('p',`p95 ${s.p95??'—'} ms · ${s.valid}/${s.runs} platných`),node('p',s.correct===null?'Správnost nehodnocena':`Správně ${s.correct}/${s.scored}`),node('p',s.costUsd===null?'Cena neznámá':`Odhad SDK $${s.costUsd.toFixed(5)}`));
    const codes=[...new Set(rows.filter(r=>r.provider===s.provider&&r.result.code).map(r=>r.result.code!))];if(codes.length)card.append(node('p',codes.map(c=>errors[c]??c).join(' · '),'errors'));return card;
  }));
}
chrome.runtime.onMessage.addListener(message=>{if(message?.event==='benchmark-progress'){benchmarkResults(message.rows);$('benchmark-state').textContent=`Hotovo ${message.rows.length} měření…`;}});
click('benchmark',async()=>{
  $('benchmark-state').textContent='Probíhá srovnání…';lastRows=[];
  const result=await rpc('benchmark',{question:val('goal'),repetitions:Number(val('repetitions')),expectedChoiceId:val('expected')||undefined});benchmarkResults(result.rows);
  $('benchmark-state').textContent=result.cancelled?'Zastaveno; dílčí výsledky jsou zachované.':result.complete?'Všichni poskytovatelé vrátili alespoň jednu platnou odpověď.':'Srovnání není kompletní. Některé integrace chybí nebo selhaly.';
});
click('export-results',async()=>saveDownload('tabora-browser-benchmark.json',JSON.stringify({version:1,mode:'snapshot-replay-cold-process',createdAt:new Date().toISOString(),summary:summarize(lastRows),rows:lastRows},null,2),'application/json'));
click('export-table',async()=>saveDownload('tabora-browser-table.csv',table.map(row=>row.map(cell=>`"${(/^[=+@\-\t\r]/.test(cell)?"'":'')+cell.replaceAll('"','""')}"`).join(',')).join('\r\n'),'text/csv;charset=utf-8'));
Object.assign(errors,{safe_mode_existing_tab:'Safe dovoluje pouze taby otevřené touto relací v její vlastní skupině.',unsupported_window:'Vyber běžné okno tohoto profilu.',readonly_mode:'Režim Jen čtení blokuje změny na stránce.',vault_disabled:'Nejprve zapni vault.',page_loading:'Stránka se stále načítá. Zkus připojení znovu.',login_required:'Přihlas se v lokálním klientu poskytovatele.',invalid_connection:'Nepodporovaný způsob připojení.'});
$('app-version').textContent=`${chrome.runtime.getManifest().version} · Lokální připojení`;
void refreshPermissions().catch(permissionCheckFailed);
void perform(async()=>{await refresh();await synchronizeProvider();await detectProfile();await refreshFiles();});
