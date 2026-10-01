import { PROVIDERS, providerNames, exactOrigin, type BrowserProfile, type SecretScope, type ProviderId, type Snapshot, type VaultMetadata } from '../shared.js';
import { summarize, type BenchmarkRow } from '../benchmark.js';
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const val=(id:string)=>$<HTMLInputElement>(id).value;
const node=(tag:string,text?:string,className?:string)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(className)n.className=className;return n;};
const option=(value:string,text:string)=>{const e=document.createElement('option');e.value=value;e.textContent=text;return e;};
let tabs:chrome.tabs.Tab[]=[],lastRows:BenchmarkRow[]=[],table:string[][]=[];
let profile:BrowserProfile|undefined,selectedSession='panel';
const scopedCommands=new Set(['status','pin','observe','decide','manual','execute','cancel','benchmark','tabs.open','session.release']);
function secretScope(value:string):SecretScope {if(value==='shared')return {type:'shared'};if(!profile)throw new Error('profile_required');return {type:'profile',profileId:profile.id};}
const errors:Record<string,string>={native_host_unavailable:'Lokální host není dostupný. Spusť scripts/install-host.ps1 podle README a obnov spojení.',vault_locked:'Nejprve odemkni vault.',missing_api_key:'U poskytovatele chybí API klíč.',missing_model:'Vyplň název modelu v nastavení poskytovatele.',decisions_preview_unavailable:'Decisions API: čeká se na ověřenou preview specifikaci.',observe_first:'Připoj stránku a načti její prvky.',no_bound_tab:'Nejprve připoj konkrétní stránku.',no_candidates:'Na stránce nebyl nalezen podporovaný cíl.',stale_snapshot:'Stránka nebo cílový prvek se změnil. Znovu načti prvky.',stale_binding:'Dokument se změnil. Připoj stránku znovu.',credential_scope_mismatch:'Účet neodpovídá přesnému HTTPS originu stránky.',ambiguous_login_form:'Přihlašovací formulář není jednoznačný. Tento případ dokonči ručně.',partial_write:'Formulář se při vyplňování změnil. Zkontroluj částečně vyplněná pole.',navigation_out_of_scope:'Cíl vede na jiný origin. Novou stránku otevři a připoj samostatně.',decision_expired:'Návrh akce už neplatí. Připrav nový.',cancelled:'Úloha byla zastavena.',timeout:'Poskytovatel překročil časový limit.',unexpected_tools:'SDK zpřístupnilo neočekávané nástroje. Rozhodnutí bylo odmítnuto.',tool_call_blocked:'Pokus SDK použít nástroj byl zablokován.',provider_failed:'Poskytovatel selhal. Zkontroluj model a přístup; citlivý výstup se nezobrazuje.',authentication_failed:'Poskytovatel odmítl přihlášení. Zkontroluj API klíč.',site_permission_required:'Povol přístup k vybranému webu.',select_credential:'Vyber účet z vaultu.',browser_error:'Browser operace selhala. Připoj stránku znovu; nepodporované stránky a iframy ovládni ručně.'};
function notice(text:string,success=false){$('notice').hidden=false;$('notice').textContent=text;$('notice').className=success?'success':'';}
Object.assign(errors,{tab_in_use:'Tab už používá jiná relace. Nejprve ji uvolni.',session_owned_by_mcp:'Tuto relaci ovládá MCP klient. Můžeš ji zastavit nebo uvolnit.',scope_conflict:'V cílové dostupnosti už existuje klíč pro tohoto poskytovatele. Nejdříve rozhodni, který zachovat.',profile_scope_mismatch:'Položka patří jinému profilu.',unknown_session:'Relace skončila. Obnov seznam relací.',mcp_access_disabled:'Pro tento profil není povolen přístup přes MCP.',busy:'V této relaci právě probíhá jiný krok.'});
async function rpc(command:string,payload?:any):Promise<any>{const r=await chrome.runtime.sendMessage({command,payload:scopedCommands.has(command)?{...payload,sessionId:selectedSession}:payload});if(!r?.ok)throw new Error(r?.code??'native_host_unavailable');return r.data;}
async function perform(fn:()=>Promise<void>){for(const b of document.querySelectorAll<HTMLButtonElement>('.when-idle'))b.disabled=true;try{await fn();}catch(e){const code=e instanceof Error?e.message:'internal_error';notice(errors[code]??code);}finally{for(const b of document.querySelectorAll<HTMLButtonElement>('.when-idle'))b.disabled=false;}}
function click(id:string,fn:()=>Promise<void>){$(id).addEventListener('click',()=>void perform(fn));}
function saveDownload(name:string,content:string,type:string){const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
for(const p of PROVIDERS)$('provider').append(option(p,providerNames[p]));
for(const button of document.querySelectorAll<HTMLButtonElement>('nav button'))button.onclick=()=>{
  for(const b of document.querySelectorAll('nav button'))b.removeAttribute('aria-current');button.setAttribute('aria-current','page');
  for(const section of document.querySelectorAll<HTMLElement>('.view'))section.hidden=section.id!==button.dataset.view;
};
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
  if(state.profile){profile=state.profile;$<HTMLInputElement>('profile-name').value=profile!.name;$<HTMLInputElement>('mcp-enabled').checked=profile!.mcpEnabled;$('profile-id').textContent=`ID profilu: ${profile!.id}`;}
  if(state.sessions){$('session').replaceChildren(...state.sessions.map((s:any)=>option(s.id,`${s.name}${s.external?' · MCP':''}`)));$<HTMLSelectElement>('session').value=selectedSession;}
  $('connection').textContent='Lokální host připojený';$('connection-dot').classList.add('online');
  $('vault-state').textContent=state.locked?'Vault je pro tento profil zamčený.':'Vault je odemčený pro tento profil.';
  if(state.locked)showVault([]);
  $('bound').textContent=state.binding?`Připojeno: ${state.binding.origin} · tab ${state.binding.tabId}`:'Připoj stránku v této relaci.';
  const labels:Record<string,string>={preview_unavailable:'Preview nedostupné',vault_locked:'Vault zamčený',missing_api_key:'Chybí API klíč',missing_model:'Chybí model',configured_unverified:'Nastaveno · netestováno',verified_session:'Ověřeno v této relaci'};
  $('provider-cards').replaceChildren(...PROVIDERS.map(p=>{
    const config=state.configs.find((c:any)=>c.provider===p),availability=state.providers.find((c:any)=>c.provider===p);
    const card=node('div',undefined,'provider-card'),head=node('div',undefined,'provider-head');head.append(node('h3',providerNames[p]),node('span',labels[availability.state]??availability.state,'badge'));card.append(head);
    if(p==='openai-decisions'){card.append(node('p','Živý adaptér se nezapne bez ověřené specifikace.','hint'));return card;}
    const form=document.createElement('form'),label=node('label','Model'),model=document.createElement('input');model.value=config.model;model.required=true;model.maxLength=120;model.id=`model-${p}`;label.setAttribute('for',model.id);
    const keyLabel=node('label','Nový API klíč (volitelné)'),key=document.createElement('input');key.id=`key-${p}`;key.type='password';key.autocomplete='new-password';keyLabel.setAttribute('for',key.id);
    const timeLabel=node('label','Limit rozhodování v sekundách'),timeout=document.createElement('input');timeout.id=`timeout-${p}`;timeout.type='number';timeout.min='1';timeout.max='120';timeout.value=String(config.timeoutMs/1000);timeLabel.setAttribute('for',timeout.id);
    const keyScopeLabel=node('label','Dostupnost nového klíče'),keyScope=document.createElement('select');keyScope.id=`scope-${p}`;keyScopeLabel.setAttribute('for',keyScope.id);keyScope.append(option('profile','Jen tento profil'),option('shared','Sdílený mezi profily'));
    const save=node('button','Uložit nastavení','secondary') as HTMLButtonElement;save.type='submit';form.append(label,model,timeLabel,timeout,keyLabel,key,keyScopeLabel,keyScope,save);
    form.onsubmit=e=>{e.preventDefault();void perform(async()=>{
      if(key.value){const secret=key.value;key.value='';await rpc('vault.put',{kind:'provider',provider:p,secret,scope:secretScope(keyScope.value)});}
      await rpc('configure',{provider:p,model:model.value.trim(),timeoutMs:Number(timeout.value)*1000});await refresh();notice('Nastavení uloženo. Skutečné volání ověří rozhodnutí nebo benchmark.',true);
    });};card.append(form);return card;
  }));
}
async function refresh(){
  try{const available=await rpc('sessions.list');if(!available.some((s:any)=>s.id===selectedSession))selectedSession=available[0]?.id??'panel';const state=await rpc('status');renderStatus(state);if(!state.locked)showVault(await rpc('vault.list'));}catch(e){$('connection').textContent='Lokální host není dostupný';$('connection-dot').classList.remove('online');throw e;}
  tabs=(await chrome.tabs.query({})).filter(t=>t.id!==undefined&&/^https?:/.test(t.url??''));
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
click('refresh',refresh);
click('profile-save',async()=>{await rpc('profile.update',{name:val('profile-name'),mcpEnabled:$<HTMLInputElement>('mcp-enabled').checked});await refresh();notice('Profil uložený.',true);});
click('site-grant',async()=>{const origin=exactOrigin(val('site-origin'));if(!await chrome.permissions.request({origins:[origin+'/*']}))throw new Error('site_permission_required');notice(`Přístup povolen: ${origin}`,true);});
$('session').addEventListener('change',()=>void perform(async()=>{selectedSession=val('session');$('preview').hidden=true;$('snapshot-box').hidden=true;$('outcome').hidden=true;await refresh();}));
click('session-create',async()=>{const s=await rpc('session.create',{name:val('session-name')||'Nová úloha'});selectedSession=s.id;await refresh();notice('Relace založena. Skupina vznikne otevřením prvního odkazu.',true);});
click('session-release',async()=>{await rpc('session.release');const s=await rpc('session.create',{name:'Ruční úloha'});selectedSession=s.id;await refresh();notice('Relace uvolněna. Taby zůstaly otevřené.',true);});
click('open-tab',async()=>{const result=await rpc('tabs.open',{url:val('open-url'),active:false});await refresh();notice(result.grouped===false?'Tab otevřen, skupinu se nepodařilo založit.':'Tab otevřen ve skupině. Po načtení ho vyber a připoj.',result.grouped!==false);});
click('pin',async()=>{
  const tab=tabs.find(t=>String(t.id)===val('tab'));if(!tab?.url)throw new Error('no_bound_tab');
  const permissions={origins:[new URL(tab.url).origin+'/*']};
  const granted=await chrome.permissions.contains(permissions)||await chrome.permissions.request(permissions);if(!granted)throw new Error('site_permission_required');
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
click('stop',stop);click('benchmark-stop',stop);
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
void perform(refresh);
