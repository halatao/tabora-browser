import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdir, mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';

const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'mcp-browser-'));
execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('tests/fixture-certificate.ps1'),'-OutputPath',path.join(directory,'fixture.pfx')],{windowsHide:true});
const fixtureServer=createServer({pfx:await readFile(path.join(directory,'fixture.pfx'))},(_req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(fixture));
await new Promise(resolve=>fixtureServer.listen(0,'127.0.0.1',resolve));
const origin=`https://127.0.0.1:${fixtureServer.address().port}`;
const extension=path.join(directory,'extension'),state=path.join(directory,'state');await cp('dist/extension',extension,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));manifest.host_permissions=['https://127.0.0.1/*'];await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
const extensionId=(await readFile('extension-id.txt','utf8')).trim(),contexts=[],clients=[],errors=[],timings=[];
let report,forcedCleanup=0;
const fixture=`<!doctype html><html><head><title>MCP fixture</title></head><body><h1>Profile fixture</h1><button onclick="document.querySelector('#count').textContent=String(Number(document.querySelector('#count').textContent)+1)">Increment</button><p id="count">0</p><form aria-label="Login"><label>Username <input name="username"></label><label>Password <input name="password" type="password"></label></form><main><label>Entry state <select name="Entry state"><option value="">Any</option><option value="accepted">Accepted</option><option value="blocked" disabled>Restricted</option></select></label><p id="filter-count">2 records found</p><button onclick="setTimeout(()=>document.querySelector('#filter-count').textContent='1 records found',50)">Search entries</button></main><nav><ul><li><button aria-expanded="false" onclick="if(document.visibilityState!=='visible')return;this.setAttribute('aria-expanded','true');document.querySelector('#menu').hidden=false;document.querySelector('#menu').style.visibility='visible'">Open menu</button><div id="menu" hidden style="visibility:hidden"><a href="#"></a>${Array.from({length:14},(_,i)=>'<a href="#">Unrelated '+i+'</a>').join('')}<a href="${origin}/next">Next page</a>${Array.from({length:12},(_,i)=>'<a href="#">Later '+i+'</a>').join('')}</div></li></ul></nav><section><h2>Last Search Terms</h2><table><tr><th>Term</th><th>Uses</th></tr><tr><td>wrong</td><td>99</td></tr></table></section><section><h2>Top Search Terms</h2><table><tr><th>Term</th><th>Uses</th></tr><tr><td>correct</td><td>20</td></tr></table></section><section><h2>Bounded data</h2><table>${Array.from({length:102},(_,i)=>'<tr>'+Array.from({length:32},(_,j)=>'<td>'+(i===0&&j===0?'x'.repeat(140):i+'-'+j)+'</td>').join('')+'</tr>').join('')}</table></section></body></html>`;
const watchdog=setTimeout(()=>{console.error('MCP browser test timed out');process.exit(1);},180000);
async function browser(name){
  const context=await chromium.launchPersistentContext(path.join(directory,name),{channel:'chromium',headless:true,ignoreHTTPSErrors:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--ignore-certificate-errors'],env:{...process.env,TABORA_STATE_DIR:state,TABORA_BROWSER_NAME:name},viewport:{width:1100,height:1000}});contexts.push(context);
  context.setDefaultTimeout(20000);
  const panel=await context.newPage();panel.on('pageerror',e=>errors.push(e.message));await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  await panel.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Lokální host připojený',undefined,{timeout:30000});
  const rpc=async(command,payload)=>{const r=await panel.evaluate(({command,payload})=>chrome.runtime.sendMessage({command,payload}),{command,payload});if(!r.ok)throw new Error(r.code);return r.data;};
  const profile=(await rpc('status')).profile;return {context,panel,rpc,profile};
}
async function client(){
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/host/mcp.js')],env:{...process.env,TABORA_STATE_DIR:state},stderr:'pipe'});
  const c=new Client({name:'tabora-browser-integration-test',version:'1.0.0'});clients.push(c);await c.connect(transport);return c;
}
async function tool(c,name,args={},expectedError){
  const start=performance.now(),result=await c.callTool({name,arguments:args});timings.push({tool:name,ms:Math.round((performance.now()-start)*100)/100});
  const data=JSON.parse(result.content.find(x=>x.type==='text').text);
  assert(!JSON.stringify(result).includes('FAKE-'),'MCP response leaked a synthetic vault value');
  if(expectedError){assert.equal(result.isError,true,JSON.stringify(data));assert.equal(data.code,expectedError);}
  else assert(!result.isError,`${name}: ${JSON.stringify(data)}`);
  return data;
}
async function fixturePage(context,url){
  for(let attempt=0;attempt<100;attempt++){
    const page=context.pages().find(p=>p.url()===url);if(page){await page.waitForSelector('#count');return page;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error(`Missing ${url}; pages: ${context.pages().map(p=>p.url()).join(', ')}`);
}
try{
  const a=await browser('profile-a');console.log('Profile A connected');const b=await browser('profile-b');console.log('Profile B connected');assert.notEqual(a.profile.id,b.profile.id);
  const c=await client();console.log('MCP client connected');assert.equal((await c.listTools()).tools.length,47);
  assert.equal((await tool(c,'browser_profiles')).length,2);
  assert.equal(a.profile.mode,'safe');assert.equal(a.profile.vaultEnabled,false);
  await a.rpc('vault.unlock').then(()=>assert.fail('Disabled vault unlocked'),e=>assert.equal(e.message,'vault_disabled'));
  await a.rpc('profile.update',{mcpEnabled:false});await b.rpc('profile.update',{mcpEnabled:false});
  assert.deepEqual(await tool(c,'browser_profiles'),[]);
  await a.rpc('profile.update',{name:'Work',mcpEnabled:true,vaultEnabled:true});assert.equal((await tool(c,'browser_profiles')).length,1);
  const providerStatus=await tool(c,'browser_provider_status',{profileId:a.profile.id});assert.equal(providerStatus.settingsScope,'host');assert.equal(providerStatus.activeProvider,'agent');
  assert.equal((await tool(c,'browser_provider_models',{profileId:a.profile.id,provider:'openai-decisions'})).state,'preview_unavailable');
  await tool(c,'browser_provider_status',{profileId:b.profile.id},'mcp_access_disabled');
  await tool(c,'browser_provider_configure',{profileId:a.profile.id,provider:'openai-decisions',model:'invented',settingsScope:'host'},'decisions_preview_unavailable');
  await tool(c,'browser_provider_select',{profileId:a.profile.id,provider:'openai-decisions'});
  assert.equal((await tool(c,'browser_profiles')).find(p=>p.id===a.profile.id).activeProvider,'openai-decisions');
  await a.panel.waitForFunction(()=>document.querySelector('#provider').value==='openai-decisions');
  await tool(c,'browser_provider_select',{profileId:a.profile.id,provider:'agent'});
  await a.panel.waitForFunction(()=>document.querySelector('#provider').value==='agent'&&document.querySelector('#model').disabled);
  assert((await c.callTool({name:'browser_provider_select',arguments:{profileId:a.profile.id,provider:'agent',vaultEnabled:false}})).isError,'MCP schema must reject vault changes');
  assert.equal((await a.rpc('status')).profile.vaultEnabled,true);
  await b.rpc('profile.update',{name:'Personal',mcpEnabled:true,vaultEnabled:true});assert.equal((await tool(c,'browser_profiles')).length,2);
  const second=await client();
  await a.rpc('vault.unlock');
  const privateSaved=await a.rpc('vault.put',{kind:'website',label:'Private work',origin,username:'work',secret:'FAKE-private-password',scope:{type:'profile',profileId:a.profile.id}});
  const privateId=privateSaved.entries.find(e=>e.label==='Private work').id;
  const sharedSaved=await a.rpc('vault.put',{kind:'website',label:'Shared',origin,username:'shared',secret:'FAKE-shared-password',scope:{type:'shared'}});
  const sharedId=sharedSaved.entries.find(e=>e.label==='Shared').id;
  await tool(c,'browser_vault_list',{profileId:b.profile.id},'vault_locked');await b.rpc('vault.unlock');
  assert.equal((await tool(c,'browser_vault_list',{profileId:b.profile.id})).length,1);
  const s1=await tool(c,'browser_session_create',{profileId:a.profile.id,name:'Research'});
  const selectedWindow=await a.panel.evaluate(async()=> (await chrome.windows.getLastFocused({windowTypes:['normal']})).id);
  const s2=await tool(c,'browser_session_create',{profileId:a.profile.id,name:'Another task',windowId:selectedWindow});
  const popup=await a.panel.evaluate(async()=> (await chrome.windows.create({type:'popup',url:'about:blank',focused:false})).id);
  await tool(c,'browser_session_create',{profileId:a.profile.id,name:'Unsupported popup',windowId:popup},'unsupported_window');
  await a.panel.evaluate(id=>chrome.windows.remove(id),popup);
  const sb=await tool(c,'browser_session_create',{profileId:b.profile.id,name:'Personal task'});
  const ordinary=await a.context.newPage();await ordinary.goto(origin+'/ordinary');
  const ordinaryId=await a.panel.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id,ordinary.url());
  await tool(c,'browser_session_attach',{sessionId:s1.id,tabId:ordinaryId},'safe_mode_existing_tab');
  const windowCount=await a.panel.evaluate(async()=> (await chrome.windows.getAll({windowTypes:['normal']})).length);
  const t1=await tool(c,'browser_session_open',{sessionId:s1.id,url:origin+'/one'});
  const t2=await tool(c,'browser_session_open',{sessionId:s1.id,url:origin+'/two'});
  const t3=await tool(c,'browser_session_open',{sessionId:s2.id,url:origin+'/other'});
  const tb=await tool(c,'browser_session_open',{sessionId:sb.id,url:origin+'/bee'});
  assert.equal(t1.groupId,t2.groupId);assert.notEqual(t1.groupId,t3.groupId);assert.equal(t1.windowId,t2.windowId);assert.equal(t1.windowId,t3.windowId);assert.equal(t3.windowId,selectedWindow);
  assert.equal(t1.windowId,await a.panel.evaluate(id=>chrome.tabs.get(id).then(t=>t.windowId),ordinaryId));
  assert.equal(await a.panel.evaluate(async()=> (await chrome.windows.getAll({windowTypes:['normal']})).length),windowCount,'Safe opens new groups without creating windows');
  await tool(c,'browser_session_attach',{sessionId:s1.id,tabId:ordinaryId},'safe_mode_existing_tab');
  await a.panel.evaluate(({tabId,groupId})=>chrome.tabs.group({tabIds:[tabId],groupId}),{tabId:ordinaryId,groupId:t1.groupId});
  await tool(c,'browser_session_attach',{sessionId:s1.id,tabId:ordinaryId},'safe_mode_existing_tab');
  assert(!(await tool(c,'browser_tabs',{profileId:a.profile.id})).some(t=>t.id===ordinaryId),'Moving an existing user tab into a Safe group must not grant access');
  await a.panel.evaluate(id=>chrome.tabs.ungroup(id),ordinaryId);
  await a.panel.evaluate(id=>chrome.tabs.ungroup(id),t2.tabId);
  await tool(c,'browser_session_attach',{sessionId:s1.id,tabId:t2.tabId},'safe_mode_existing_tab');
  await a.panel.evaluate(({tabId,groupId})=>chrome.tabs.group({tabIds:[tabId],groupId}),t2);
  console.log('Groups created');
  assert.equal((await a.panel.evaluate(groupId=>chrome.tabGroups.get(groupId),t1.groupId)).title,'Research');
  const p1=await fixturePage(a.context,origin+'/one'),pb=await fixturePage(b.context,origin+'/bee');
  await tool(c,'browser_session_attach',{sessionId:s1.id,tabId:t1.tabId});
  await tool(c,'browser_session_attach',{sessionId:s2.id,tabId:t1.tabId},'tab_in_use');
  await tool(second,'browser_session_attach',{sessionId:s1.id,tabId:t1.tabId},'session_not_owned');
  await tool(c,'browser_session_attach',{sessionId:sb.id,tabId:tb.tabId});
  const all=await tool(c,'browser_observe',{sessionId:s1.id,recipe:'all'});
  const tables=all.snapshot.targets.filter(t=>t.kind==='table');assert.equal(tables[0].name,tables[1].name);assert.notEqual(tables[0].section,tables[1].section);assert.equal(tables[1].section,'Top Search Terms');assert.equal(tables[1].preview[1][0],'correct');
  const bounded=await tool(c,'browser_prepare',{sessionId:s1.id,recipe:'extract',targetId:tables[2].id});
  const extracted=await tool(c,'browser_step',{sessionId:s1.id,actionId:bounded.actionId,stateVersion:all.snapshot.documentToken? all.snapshot.documentToken:'invalid'},'stale_snapshot');
  const binding=(await a.rpc('status',{sessionId:s1.id})).binding;
  const boundedStep=await tool(c,'browser_step',{sessionId:s1.id,actionId:bounded.actionId,stateVersion:binding.documentId+':'+all.snapshot.documentToken});assert.equal(boundedStep.action.truncated,true);assert.deepEqual(boundedStep.action.truncation,{rows:true,columns:true,cells:true});
  const dynamicTable=boundedStep.snapshot.targets.filter(t=>t.kind==='table')[1];
  const dynamicRead=await tool(c,'browser_prepare',{sessionId:s1.id,recipe:'extract',targetId:dynamicTable.id});
  await p1.locator('table').nth(1).locator('td').first().evaluate(el=>el.innerHTML='<span>fresh</span><span style="display:none">hidden script data</span>');
  const latest=await tool(c,'browser_step',{sessionId:s1.id,actionId:dynamicRead.actionId,stateVersion:boundedStep.binding.documentId+':'+boundedStep.snapshot.documentToken});
  assert.equal(latest.action.rows[1][0],'fresh','A bound read must read the latest rendered row without hidden text');
  const control=latest.snapshot.targets.find(t=>t.kind==='select');assert.equal(control.name,'Entry state');assert(control.options.some(o=>o.label==='Restricted'&&o.disabled));assert(!JSON.stringify(control).includes('accepted'),'Option wire values must remain in the extension');
  const deniedOption=await tool(c,'browser_prepare',{sessionId:s1.id,recipe:'fill',targetId:control.id,selectOptionIndex:2});
  await tool(c,'browser_step',{sessionId:s1.id,actionId:deniedOption.actionId,stateVersion:latest.binding.documentId+':'+latest.snapshot.documentToken,expect:'none'},'invalid_option');
  await tool(c,'browser_prepare',{sessionId:s1.id,recipe:'click',targetId:control.id,selectOptionIndex:1},'invalid_fields');
  const staleOption=await tool(c,'browser_prepare',{sessionId:s1.id,recipe:'fill',targetId:control.id,selectOptionIndex:1});
  await p1.locator('select[name="Entry state"]').evaluate(el=>el.options[1].value='private-wire-option');
  await tool(c,'browser_step',{sessionId:s1.id,actionId:staleOption.actionId,stateVersion:latest.binding.documentId+':'+latest.snapshot.documentToken,expect:'none'},'stale_snapshot');
  const refreshedOptions=await tool(c,'browser_observe',{sessionId:s1.id,recipe:'all'});latest.snapshot=refreshedOptions.snapshot;
  assert(!JSON.stringify(refreshedOptions).includes('private-wire-option'));
  const optionAction=await tool(c,'browser_prepare',{sessionId:s1.id,recipe:'fill',targetId:control.id,selectOptionIndex:1});
  const selectedOption=await tool(c,'browser_step',{sessionId:s1.id,actionId:optionAction.actionId,stateVersion:latest.binding.documentId+':'+latest.snapshot.documentToken,expect:'none'});
  assert(selectedOption.snapshot.targets.find(t=>t.kind==='select').options.some(o=>o.index===1&&o.selected));
  assert.equal(selectedOption.snapshot.dataVersion,latest.snapshot.dataVersion,'Changing a select is not proof of filtered results');
  const search=selectedOption.snapshot.targets.find(t=>t.name==='Search entries');
  const searchAction=await tool(c,'browser_prepare',{sessionId:s1.id,recipe:'click',targetId:search.id});
  const filtered=await tool(c,'browser_step',{sessionId:s1.id,actionId:searchAction.actionId,stateVersion:selectedOption.binding.documentId+':'+selectedOption.snapshot.documentToken});
  assert.notEqual(filtered.snapshot.dataVersion,selectedOption.snapshot.dataVersion);assert(filtered.snapshot.text.includes('1 records found'));
  // This site requires visibility. CDP emulation must satisfy it without activating the owned tab.
  await a.panel.evaluate(id=>chrome.tabs.update(id,{active:true}),ordinaryId);
  assert.equal(await a.panel.evaluate(id=>chrome.tabs.get(id).then(t=>t.active),t1.tabId),false);
  const menu=filtered.snapshot.targets.find(t=>t.name==='Open menu');assert(menu.contains.includes('Next page'));assert.equal(menu.contains.length,24);assert.equal(menu.containsTruncated,true);assert(!menu.contains.includes(''));assert(!latest.snapshot.targets.some(t=>t.name==='Next page'),'Collapsed hints must not become executable targets');const menuAction=await tool(c,'browser_prepare',{sessionId:s1.id,recipe:'click',targetId:menu.id});
  const expanded=await tool(c,'browser_step',{sessionId:s1.id,actionId:menuAction.actionId,stateVersion:filtered.binding.documentId+':'+filtered.snapshot.documentToken});assert.equal(expanded.readiness.state,'observed');assert.equal(expanded.snapshot.targets.find(t=>t.name==='Open menu').expanded,true);assert.equal(await a.panel.evaluate(id=>chrome.tabs.get(id).then(t=>t.active),t1.tabId),false);
  const link=expanded.snapshot.targets.find(t=>t.name==='Next page'),linkAction=await tool(c,'browser_prepare',{sessionId:s1.id,recipe:'click',targetId:link.id});
  const navigated=await tool(c,'browser_step',{sessionId:s1.id,actionId:linkAction.actionId,stateVersion:expanded.binding.documentId+':'+expanded.snapshot.documentToken});assert.equal(navigated.readiness.navigated,true);assert.equal(navigated.snapshot.path,'/next');assert.notEqual(navigated.binding.documentId,expanded.binding.documentId);
  await tool(c,'browser_step',{sessionId:s1.id,actionId:linkAction.actionId,stateVersion:expanded.binding.documentId+':'+expanded.snapshot.documentToken},'stale_snapshot');
  // Return to the original document only as fixture preparation, outside scored actions.
  await p1.goto(origin+'/one');await tool(c,'browser_session_attach',{sessionId:s1.id,tabId:t1.tabId});
  const login=async(sessionId,credentialId,error)=>{
    const observed=await tool(c,'browser_observe',{sessionId,recipe:'login'});
    const prepared=await tool(c,'browser_prepare',{sessionId,recipe:'login',targetId:observed.snapshot.targets[0].id,credentialId});
    await tool(c,'browser_execute',{sessionId,actionId:prepared.actionId},error);return prepared;
  };
  await login(s1.id,privateId);assert.equal(await p1.locator('[name=password]').inputValue(),'FAKE-private-password');
  await login(sb.id,privateId,'credential_scope_mismatch');assert.equal(await pb.locator('[name=password]').inputValue(),'');
  await login(sb.id,sharedId);assert.equal(await pb.locator('[name=password]').inputValue(),'FAKE-shared-password');
  await a.rpc('vault.scope',{id:sharedId,scope:{type:'profile',profileId:a.profile.id}});
  await tool(c,'browser_observe',{sessionId:s1.id,recipe:'extract'},'no_bound_tab');await tool(c,'browser_session_attach',{sessionId:s1.id,tabId:t1.tabId});
  await tool(c,'browser_observe',{sessionId:sb.id,recipe:'extract'},'no_bound_tab');await tool(c,'browser_session_attach',{sessionId:sb.id,tabId:tb.tabId});
  assert.equal((await tool(c,'browser_vault_list',{profileId:b.profile.id})).length,0);await login(sb.id,sharedId,'credential_scope_mismatch');
  // Independent work in two profiles can overlap; a prepared action is single-use.
  async function increment(sessionId){const observed=await tool(c,'browser_observe',{sessionId,recipe:'click'});const action=await tool(c,'browser_prepare',{sessionId,recipe:'click',targetId:observed.snapshot.targets[0].id});await tool(c,'browser_execute',{sessionId,actionId:action.actionId});return action;}
  const [once]=await Promise.all([increment(s1.id),increment(sb.id)]);
  assert.equal(await p1.locator('#count').textContent(),'1');assert.equal(await pb.locator('#count').textContent(),'1');
  await tool(c,'browser_execute',{sessionId:s1.id,actionId:once.actionId},'decision_expired');
  const providerObserved=await tool(c,'browser_observe',{sessionId:s1.id,recipe:'click'}),providerAction=await tool(c,'browser_prepare',{sessionId:s1.id,recipe:'click',targetId:providerObserved.snapshot.targets[0].id});
  await tool(c,'browser_provider_select',{profileId:a.profile.id,provider:'openai-decisions'});
  await tool(c,'browser_execute',{sessionId:s1.id,actionId:providerAction.actionId},'decision_expired');
  assert.equal(await p1.locator('#count').textContent(),'1','Switching providers must not execute a pending click');
  assert.equal((await tool(c,'browser_observe',{sessionId:sb.id,recipe:'click'})).snapshot.path,'/bee','Provider preference changes remain profile-scoped');
  await tool(c,'browser_provider_select',{profileId:a.profile.id,provider:'agent'});
  await tool(c,'browser_session_attach',{sessionId:s1.id,tabId:t1.tabId});
  const globalBefore=await tool(c,'browser_observe',{sessionId:s1.id,recipe:'click'}),globalAction=await tool(c,'browser_prepare',{sessionId:s1.id,recipe:'click',targetId:globalBefore.snapshot.targets[0].id});
  const otherBefore=await tool(c,'browser_observe',{sessionId:sb.id,recipe:'click'}),otherAction=await tool(c,'browser_prepare',{sessionId:sb.id,recipe:'click',targetId:otherBefore.snapshot.targets[0].id});
  const originalConfig=(await tool(c,'browser_provider_status',{profileId:a.profile.id})).configs.find(p=>p.provider==='codex-sdk');
  // Panel configure shares the same host persistence/invalidation path. No model
  // inference/catalog call is made with this synthetic configuration.
  await a.rpc('configure',{...originalConfig,model:'synthetic-configure-only'});
  assert.equal((await tool(c,'browser_provider_status',{profileId:b.profile.id})).configs.find(p=>p.provider==='codex-sdk').model,'synthetic-configure-only');
  await tool(c,'browser_execute',{sessionId:s1.id,actionId:globalAction.actionId},'decision_expired');
  await tool(c,'browser_execute',{sessionId:sb.id,actionId:otherAction.actionId},'decision_expired');
  await a.rpc('configure',originalConfig);
  await tool(c,'browser_session_attach',{sessionId:s1.id,tabId:t1.tabId});await tool(c,'browser_session_attach',{sessionId:sb.id,tabId:tb.tabId});
  const before=await tool(c,'browser_observe',{sessionId:s1.id,recipe:'click'}),stale=await tool(c,'browser_prepare',{sessionId:s1.id,recipe:'click',targetId:before.snapshot.targets[0].id});
  await p1.reload();await tool(c,'browser_execute',{sessionId:s1.id,actionId:stale.actionId},'decision_expired');
  await tool(c,'browser_session_attach',{sessionId:s1.id,tabId:t1.tabId});await increment(s1.id);
  const denied=await tool(c,'browser_session_open',{sessionId:s2.id,url:origin.replace('127.0.0.1','localhost')+'/denied'});
  await fixturePage(a.context,origin.replace('127.0.0.1','localhost')+'/denied');
  await tool(c,'browser_session_attach',{sessionId:s2.id,tabId:denied.tabId},'site_permission_required');
  await tool(c,'browser_session_release',{sessionId:s1.id});assert(!p1.isClosed());
  await tool(c,'browser_session_attach',{sessionId:s2.id,tabId:t1.tabId},'safe_mode_existing_tab');
  await tool(c,'browser_session_attach',{sessionId:s2.id,tabId:t3.tabId});
  const modeObserved=await tool(c,'browser_observe',{sessionId:s2.id,recipe:'click'});
  const modeAction=await tool(c,'browser_prepare',{sessionId:s2.id,recipe:'click',targetId:modeObserved.snapshot.targets[0].id});
  await a.rpc('profile.update',{mode:'readonly'});
  await tool(c,'browser_execute',{sessionId:s2.id,actionId:modeAction.actionId},'decision_expired');
  await tool(c,'browser_session_attach',{sessionId:s2.id,tabId:ordinaryId});
  await tool(c,'browser_observe',{sessionId:s2.id,recipe:'click'},'readonly_mode');
  await tool(c,'browser_observe',{sessionId:s2.id,recipe:'fill'},'readonly_mode');
  const read=await tool(c,'browser_observe',{sessionId:s2.id,recipe:'extract'});
  const textTarget=read.snapshot.targets.find(t=>t.kind==='text');assert(textTarget);
  const readAction=await tool(c,'browser_prepare',{sessionId:s2.id,recipe:'extract',targetId:textTarget.id});
  const text=await tool(c,'browser_execute',{sessionId:s2.id,actionId:readAction.actionId});assert(text.text.includes('Profile fixture'));
  assert.equal(await ordinary.locator('#count').textContent(),'0');
  await a.rpc('profile.update',{mode:'takeover',vaultEnabled:false});
  await a.rpc('vault.list').then(()=>assert.fail('Disabled vault list'),e=>assert.equal(e.message,'vault_disabled'));
  await tool(c,'browser_session_attach',{sessionId:s2.id,tabId:t1.tabId});
  await tool(c,'browser_observe',{sessionId:s2.id,recipe:'login'},'vault_disabled');
  await a.rpc('profile.update',{name:'Work',mcpEnabled:false});assert.equal((await tool(c,'browser_profiles')).length,1);
  await tool(c,'browser_observe',{sessionId:s2.id,recipe:'click'},'session_not_owned');
  // Finished work closes created tabs only; user tabs and tabs moved out survive.
  await a.rpc('profile.update',{mcpEnabled:true,mode:'safe'});
  const cleanupSession=await tool(c,'browser_session_create',{profileId:a.profile.id,name:'Completed cleanup'});
  const cleanupTab=await tool(c,'browser_session_open',{sessionId:cleanupSession.id,url:origin+'/cleanup'});
  const movedCleanupTab=await tool(c,'browser_session_open',{sessionId:cleanupSession.id,url:origin+'/cleanup-moved'});
  await a.panel.evaluate(id=>chrome.tabs.ungroup(id),movedCleanupTab.tabId);
  await a.panel.evaluate(({id,groupId})=>chrome.tabs.group({tabIds:[id],groupId}),{id:ordinaryId,groupId:cleanupTab.groupId});
  const cleanupResult=await tool(c,'browser_session_release',{sessionId:cleanupSession.id,closeCreatedTabs:true});
  assert.deepEqual(cleanupResult.closedTabIds,[cleanupTab.tabId]);assert.deepEqual(cleanupResult.retainedTabIds,[movedCleanupTab.tabId]);assert.deepEqual(cleanupResult.failedTabIds,[]);
  assert(await a.panel.evaluate(id=>chrome.tabs.get(id).then(t=>!!t),ordinaryId));
  assert(await a.panel.evaluate(id=>chrome.tabs.get(id).then(t=>!!t),movedCleanupTab.tabId));
  assert(await a.panel.evaluate(id=>chrome.tabGroups.get(id).then(g=>!!g),cleanupTab.groupId));
  const emptySession=await tool(c,'browser_session_create',{profileId:a.profile.id,name:'Empty cleanup'});
  const emptyTab=await tool(c,'browser_session_open',{sessionId:emptySession.id,url:origin+'/cleanup-empty'});
  assert.equal((await tool(c,'browser_session_release',{sessionId:emptySession.id,closeCreatedTabs:true})).tabsClosed,true);
  assert.equal(await a.panel.evaluate(id=>chrome.tabGroups.get(id).then(()=>true,()=>false),emptyTab.groupId),false);
  await a.rpc('profile.update',{mcpEnabled:false});
  await a.panel.locator('#manual-controls').evaluate(el=>el.open=true);
  await a.panel.setViewportSize({width:380,height:1050});assert(await a.panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await mkdir('reports/mcp',{recursive:true});await a.panel.screenshot({path:'reports/mcp/profile-panel.png',fullPage:true});
  await b.panel.locator('#refresh').click();await b.panel.locator('#vault-details').evaluate(el=>el.open=true);await b.panel.screenshot({path:'reports/mcp/vault-scopes.png',fullPage:true});
  await c.close();await new Promise(resolve=>setTimeout(resolve,250));
  assert.equal((await b.rpc('sessions.list')).filter(s=>s.external).length,0);
  assert.deepEqual(errors,[]);
  console.log('Integration assertions passed; closing test resources');
  report={completedAt:new Date().toISOString(),profiles:2,mcpClients:2,tools:47,passed:true,checks:['provider catalog and exact model validation','MCP provider selection updates panel','provider selection revokes pending actions in only its profile','stdio MCP handshake','automatic MCP access with revocation','Safe new groups in existing windows and existing-tab denial','Safe rejects tabs moved out of the group','Readonly extraction and mutation denial','mode switch revokes prepared action','disabled vault blocks credentials','same-session group reuse','tab ownership','client ownership','section titles and table previews','all extraction bounds reported','atomic menu readiness','atomic navigation rebind','stale revision rejection without replay','profile-scoped unlock','private credential denial across profiles','shared credential fill','scope revocation','parallel profiles','single-use actions','navigation invalidation and reattach','missing host permission','release leaves tabs open','MCP disable revokes sessions','client disconnect cleanup','380px layout'],timings};
}catch(error){console.error('MCP integration failed before cleanup:',error);throw error;}finally{
  for(const c of clients)await c.close().catch(()=>{});
  for(const [index,context] of contexts.entries()){
    let timer;const closing=context.close();
    try{await Promise.race([closing,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Browser cleanup timed out')),5000);})]);}
    catch{forcedCleanup++;execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('tests/close-browser.ps1'),'-ProfilePath',path.join(directory,index===0?'profile-a':'profile-b')],{windowsHide:true,stdio:'ignore'});await Promise.race([closing,new Promise(resolve=>setTimeout(resolve,1000))]);}
    finally{clearTimeout(timer);}
  }clearTimeout(watchdog);
  fixtureServer.closeAllConnections();await new Promise(resolve=>fixtureServer.close(resolve));
  assert.equal(path.dirname(directory),base);await rm(directory,{recursive:true,force:true,maxRetries:5});
}
await writeFile('reports/mcp/integration.json',JSON.stringify({...report,forcedTestBrowserCleanup:forcedCleanup},null,2));
console.log('PASS: real MCP stdio -> broker -> native bridges -> two Chromium profiles; groups, ownership, vault scopes, revocation, parallel actions, navigation and cleanup.');
