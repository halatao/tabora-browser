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
const fixture=`<!doctype html><html><head><title>MCP fixture</title></head><body><h1>Profile fixture</h1><button onclick="document.querySelector('#count').textContent=String(Number(document.querySelector('#count').textContent)+1)">Increment</button><p id="count">0</p><form aria-label="Login"><label>Username <input name="username"></label><label>Password <input name="password" type="password"></label></form></body></html>`;
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
  const c=await client();console.log('MCP client connected');assert.equal((await c.listTools()).tools.length,13);
  assert.equal((await tool(c,'browser_profiles')).length,2);
  assert.equal(a.profile.mode,'safe');assert.equal(a.profile.vaultEnabled,false);
  await a.rpc('vault.unlock').then(()=>assert.fail('Disabled vault unlocked'),e=>assert.equal(e.message,'vault_disabled'));
  await a.rpc('profile.update',{mcpEnabled:false});await b.rpc('profile.update',{mcpEnabled:false});
  assert.deepEqual(await tool(c,'browser_profiles'),[]);
  await a.rpc('profile.update',{name:'Work',mcpEnabled:true,vaultEnabled:true});assert.equal((await tool(c,'browser_profiles')).length,1);
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
  const s2=await tool(c,'browser_session_create',{profileId:a.profile.id,name:'Another task'});
  const sb=await tool(c,'browser_session_create',{profileId:b.profile.id,name:'Personal task'});
  const ordinary=await a.context.newPage();await ordinary.goto(origin+'/ordinary');
  const ordinaryId=await a.panel.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id,ordinary.url());
  await tool(c,'browser_session_attach',{sessionId:s1.id,tabId:ordinaryId},'safe_mode_existing_tab');
  const t1=await tool(c,'browser_session_open',{sessionId:s1.id,url:origin+'/one'});
  const t2=await tool(c,'browser_session_open',{sessionId:s1.id,url:origin+'/two'});
  const t3=await tool(c,'browser_session_open',{sessionId:s2.id,url:origin+'/other'});
  const tb=await tool(c,'browser_session_open',{sessionId:sb.id,url:origin+'/bee'});
  assert.equal(t1.groupId,t2.groupId);assert.notEqual(t1.groupId,t3.groupId);assert.equal(t1.windowId,t2.windowId);assert.notEqual(t1.windowId,t3.windowId);
  assert.notEqual(t1.windowId,await a.panel.evaluate(id=>chrome.tabs.get(id).then(t=>t.windowId),ordinaryId));
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
  const login=async(sessionId,credentialId,error)=>{
    const observed=await tool(c,'browser_observe',{sessionId,recipe:'login'});
    const prepared=await tool(c,'browser_prepare',{sessionId,recipe:'login',targetId:observed.snapshot.targets[0].id,credentialId});
    await tool(c,'browser_execute',{sessionId,actionId:prepared.actionId},error);return prepared;
  };
  await login(s1.id,privateId);assert.equal(await p1.locator('[name=password]').inputValue(),'FAKE-private-password');
  await login(sb.id,privateId,'credential_scope_mismatch');assert.equal(await pb.locator('[name=password]').inputValue(),'');
  await login(sb.id,sharedId);assert.equal(await pb.locator('[name=password]').inputValue(),'FAKE-shared-password');
  await a.rpc('vault.scope',{id:sharedId,scope:{type:'profile',profileId:a.profile.id}});
  assert.equal((await tool(c,'browser_vault_list',{profileId:b.profile.id})).length,0);await login(sb.id,sharedId,'credential_scope_mismatch');
  // Independent work in two profiles can overlap; a prepared action is single-use.
  async function increment(sessionId){const observed=await tool(c,'browser_observe',{sessionId,recipe:'click'});const action=await tool(c,'browser_prepare',{sessionId,recipe:'click',targetId:observed.snapshot.targets[0].id});await tool(c,'browser_execute',{sessionId,actionId:action.actionId});return action;}
  const [once]=await Promise.all([increment(s1.id),increment(sb.id)]);
  assert.equal(await p1.locator('#count').textContent(),'1');assert.equal(await pb.locator('#count').textContent(),'1');
  await tool(c,'browser_execute',{sessionId:s1.id,actionId:once.actionId},'decision_expired');
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
  await a.panel.locator('#manual-controls').evaluate(el=>el.open=true);
  await a.panel.setViewportSize({width:380,height:1050});assert(await a.panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await mkdir('reports/mcp',{recursive:true});await a.panel.screenshot({path:'reports/mcp/profile-panel.png',fullPage:true});
  await b.panel.locator('#refresh').click();await b.panel.locator('#vault-details').evaluate(el=>el.open=true);await b.panel.screenshot({path:'reports/mcp/vault-scopes.png',fullPage:true});
  await c.close();await new Promise(resolve=>setTimeout(resolve,250));
  assert.equal((await b.rpc('sessions.list')).filter(s=>s.external).length,0);
  assert.deepEqual(errors,[]);
  console.log('Integration assertions passed; closing test resources');
  report={completedAt:new Date().toISOString(),profiles:2,mcpClients:2,tools:13,passed:true,checks:['stdio MCP handshake','automatic MCP access with revocation','Safe new windows/groups and existing-tab denial','Safe rejects tabs moved out of the group','Readonly extraction and mutation denial','mode switch revokes prepared action','disabled vault blocks credentials','same-session group reuse','tab ownership','client ownership','profile-scoped unlock','private credential denial across profiles','shared credential fill','scope revocation','parallel profiles','single-use actions','navigation invalidation and reattach','missing host permission','release leaves tabs open','MCP disable revokes sessions','client disconnect cleanup','380px layout'],timings};
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
