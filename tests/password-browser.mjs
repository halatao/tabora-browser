import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {Vault} from '../src/host/vault.ts';
import {HostService} from '../src/host/service.ts';
import {BrokerRouter} from '../src/host/broker-router.ts';

// Disposable HTTPS site, synthetic encrypted vault, and an extension without nativeMessaging.
const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'password-browser-'));
const extension=path.join(directory,'extension');await mkdir(extension);
const pfx=path.join(directory,'fixture.pfx');execFileSync('pwsh.exe',['-NoProfile','-File',path.resolve('tests/fixture-certificate.ps1'),'-OutputPath',pfx],{windowsHide:true});
let key;const vault=new Vault(path.join(directory,'vault.json'),{protect:async value=>{key=Buffer.from(value);return Buffer.from('synthetic-key-handle');},unprotect:async()=>Buffer.from(key)});
const service=new HostService(vault,directory),profileId=randomUUID(),token=randomUUID();
let accepted=false,submits=0,serverPassword='SYNTHETIC-OLD';
const html=`<!doctype html><style>body{font:18px sans-serif;padding:30px}label{display:block;margin:20px}input{padding:10px}</style><h1>Password reset fixture</h1><form><label>New password<input type="password" autocomplete="new-password" name="password"></label><label>Confirm password<input type="password" autocomplete="new-password" name="confirmation"></label><button>Save password</button></form><output aria-label="Result"></output><script>document.querySelector('form').onsubmit=async event=>{event.preventDefault();const r=await fetch('/submit',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(event.target)))});document.querySelector('output').textContent=r.ok?'Password saved':'Password rejected';};</script>`;
const server=createServer({pfx:await readFile(pfx)},async(req,res)=>{
  if(req.url==='/host'){
    if(req.headers.authorization!==token){res.writeHead(403);res.end();return;}
    let body='';for await(const part of req)body+=part;
    try{const p=JSON.parse(body);res.end(JSON.stringify({ok:true,data:await service.handle(profileId,p.sessionId,p.command,p.payload,true)}));}
    catch(error){res.end(JSON.stringify({ok:false,code:error.code??error.message}));}return;
  }
  if(req.url==='/submit'){
    let body='';for await(const part of req)body+=part;const p=JSON.parse(body);submits++;
    const ok=accepted&&p.password===p.confirmation&&p.password.length>=16;if(ok)serverPassword=p.password;
    res.writeHead(ok?200:422);res.end();return;
  }
  res.setHeader('content-type','text/html');res.end(html);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='https://127.0.0.1:'+server.address().port;
await service.handle(profileId,'panel','vault.unlock',{});
const credentialId=await vault.put({kind:'website',label:'Synthetic reset',origin,username:'fixture',secret:serverPassword,scope:{type:'profile',profileId}},profileId);
await writeFile(path.join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'Isolated Tabora password tests',version:'1.0.0',permissions:['scripting','tabs','webNavigation'],host_permissions:['https://127.0.0.1/*'],background:{service_worker:'worker.js',type:'module'}}));
await build({stdin:{contents:`import {createBrowserSession} from './src/extension/session.ts';
const sessions=new Map();globalThis.fixturePolicy={mode:'takeover',vaultEnabled:true};globalThis.createFixture=id=>{sessions.set(id,createBrowserSession(id,id,true,async(command,payload)=>{const reply=await(await fetch(${JSON.stringify(origin+'/host')},{method:'POST',headers:{authorization:${JSON.stringify(token)}},body:JSON.stringify({sessionId:id,command,payload})})).json();if(!reply.ok)throw Error(reply.code);return reply.data;},()=>globalThis.fixturePolicy,async tabId=>{if(new URL((await chrome.tabs.get(tabId)).url).origin!==${JSON.stringify(origin)})throw Error('out_of_scope');},()=>[${JSON.stringify(origin)}]));};
globalThis.fixtureCall=async(id,name,input)=>{try{return {ok:true,data:await sessions.get(id).invoke(name,input)};}catch(error){return {ok:false,code:error.code??error.message};}};`,resolveDir:process.cwd(),sourcefile:'password-fixture.ts'},outfile:path.join(extension,'worker.js'),bundle:true,format:'esm',platform:'browser',define:{__TABORA_BUILD__:JSON.stringify({version:'0.6.3',fingerprint:'a'.repeat(64),contractVersion:2})}});
await build({entryPoints:['src/extension/sensor.ts'],outfile:path.join(extension,'sensor.js'),bundle:true,format:'iife',platform:'browser'});
let context;const router=new BrokerRouter(),outputs=[];
const watchdog=setTimeout(()=>{console.error('Password fixture timed out');process.exit(1);},120000);
try{
  context=await chromium.launchPersistentContext(path.join(directory,'chromium'),{channel:'chromium',headless:true,ignoreHTTPSErrors:true,args:['--ignore-certificate-errors',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');const page=await context.newPage();await page.goto(origin);
  const tabId=await worker.evaluate(async origin=>(await chrome.tabs.query({})).find(tab=>tab.url===origin+'/').id,origin);
  router.register({profile:{id:profileId,name:'Synthetic',mcpEnabled:true,mode:'takeover',vaultEnabled:true},call:async(command,payload)=>{
    if(command==='session.create'){await worker.evaluate(id=>globalThis.createFixture(id),payload.id);return {id:payload.id};}
    if(command==='password.list')return service.handle(profileId,'panel',command,{});
    if(command==='session.release')return {};
    const result=await worker.evaluate(({sessionId,name,input})=>globalThis.fixtureCall(sessionId,name,input),{sessionId:payload.sessionId,name:command,input:(({sessionId,...p})=>p)(payload)});
    if(!result.ok)throw Error(result.code);return result.data;
  }});
  const session=await router.call('owner','browser_session_create',{profileId,name:'Synthetic reset'}),sessionId=session.id;
  async function tool(name,input={}){const result=await router.call('owner',name,{sessionId,...input});outputs.push(vault.redact(result));return result;}
  await tool('browser_session_attach',{tabId});
  const state=()=>tool('browser_state',{frameId:0,cursor:0,limit:100});
  const fields=s=>({stateVersion:s.stateVersion,passwordTargetId:s.snapshot.targets.find(t=>t.name==='New password').id,confirmationTargetId:s.snapshot.targets.find(t=>t.name==='Confirm password').id});
  let s=await state();const first=await tool('browser_password_prepare',{stateVersion:s.stateVersion,credentialId});
  const beforeFill=s;
  await assert.rejects(tool('browser_password_fill',{...fields(s),changeId:first.changeId,confirmationTargetId:fields(s).passwordTargetId}));
  const fill=await tool('browser_password_fill',{...fields(s),changeId:first.changeId});assert.equal(fill.status,'filled');assert.equal(fill.submitted,false);assert.equal(submits,0);
  const generated=await page.locator('[name=password]').inputValue();assert.equal(await page.locator('[name=confirmation]').inputValue(),generated);assert.notEqual(generated,'SYNTHETIC-OLD');
  await assert.rejects(tool('browser_password_fill',{...fields(beforeFill),changeId:first.changeId}));
  s=await state();assert(!JSON.stringify(s).includes(generated));
  let plan=await tool('browser_plan',{stateVersion:s.stateVersion,action:{type:'click',targetId:s.snapshot.targets.find(t=>t.name==='Save password').id,backend:'dom'}});
  await tool('browser_commit',{actionId:plan.actionId,stateVersion:s.stateVersion});await page.getByText('Password rejected',{exact:true}).waitFor();
  s=await state();await tool('browser_password_resolve',{changeId:first.changeId,stateVersion:s.stateVersion,outcome:'rejected'});assert.equal(vault.websiteSecret(credentialId,origin,profileId).password,'SYNTHETIC-OLD');
  accepted=true;await page.reload();await tool('browser_session_attach',{tabId});s=await state();const second=await tool('browser_password_prepare',{stateVersion:s.stateVersion,credentialId});
  await tool('browser_password_fill',{...fields(s),changeId:second.changeId});s=await state();
  plan=await tool('browser_plan',{stateVersion:s.stateVersion,action:{type:'click',targetId:s.snapshot.targets.find(t=>t.name==='Save password').id,backend:'dom'}});
  await tool('browser_commit',{actionId:plan.actionId,stateVersion:s.stateVersion});await page.getByText('Password saved',{exact:true}).waitFor();s=await state();
  const saved=await tool('browser_password_resolve',{changeId:second.changeId,stateVersion:s.stateVersion,outcome:'confirmed',confirmation:'agent_verified'});
  assert.equal(saved.status,'saved');assert.equal(vault.list(profileId).length,1);assert.equal(vault.websiteSecret(credentialId,origin,profileId).password,serverPassword);assert.equal(submits,2);
  assert(!JSON.stringify(outputs).includes(generated));assert(!JSON.stringify(outputs).includes(serverPassword));
  assert(!(await readFile(path.join(directory,'vault.json'),'utf8')).includes(serverPassword));
  await worker.evaluate(()=>{globalThis.fixturePolicy.mode='readonly';});
  await assert.rejects(tool('browser_password_prepare',{stateVersion:s.stateVersion,credentialId}),{message:'readonly_mode'});
  await worker.evaluate(()=>{globalThis.fixturePolicy={mode:'takeover',vaultEnabled:false};});
  await assert.rejects(tool('browser_password_prepare',{stateVersion:s.stateVersion,credentialId}),{message:'vault_disabled'});
  await worker.evaluate(()=>{globalThis.fixturePolicy.vaultEnabled=true;});
  await page.reload();await page.evaluate(()=>{const label=document.createElement('label');label.textContent='Current password';const input=document.createElement('input');input.type='password';input.autocomplete='current-password';input.name='current';label.append(input);document.querySelector('form').prepend(label);});
  await tool('browser_session_attach',{tabId});s=await state();const third=await tool('browser_password_prepare',{stateVersion:s.stateVersion,credentialId});
  const currentPasswordTargetId=s.snapshot.targets.find(t=>t.name==='Current password').id;
  await assert.rejects(tool('browser_password_fill',{...fields(s),changeId:third.changeId,passwordTargetId:currentPasswordTargetId}),{message:'password_field_purpose_mismatch'});
  assert.equal(vault.passwordChanges(profileId).find(c=>c.changeId===third.changeId).status,'prepared');
  await tool('browser_password_fill',{...fields(s),changeId:third.changeId,currentPasswordTargetId});assert.equal(await page.locator('[name=current]').inputValue(),serverPassword);
  s=await state();await tool('browser_password_resolve',{changeId:third.changeId,stateVersion:s.stateVersion,outcome:'rejected'});
  await page.reload();await tool('browser_session_attach',{tabId});s=await state();const fourth=await tool('browser_password_prepare',{stateVersion:s.stateVersion,credentialId});
  await page.evaluate(()=>document.querySelector('[name=password]').addEventListener('input',()=>{document.querySelector('[name=confirmation]').type='text';},{once:true}));
  const partial=await tool('browser_password_fill',{...fields(s),changeId:fourth.changeId});assert.equal(partial.status,'unknown');assert.equal(partial.verified,false);assert.equal(await page.locator('[name=confirmation]').inputValue(),'');
  assert.equal(vault.websiteSecret(credentialId,origin,profileId).password,serverPassword);assert.equal(submits,2);
  console.log(JSON.stringify({passed:true,checks:['owned MCP routing to real extension and host','HTTPS reset with confirmation and no username field','no automatic submit or retry','website rejection preserves old password','website acceptance updates same ID','secrets absent from tool outputs, observations and encrypted disk','readonly and vault-disabled policies','change form with current password and purpose validation','field replacement during input fails closed with unknown outcome'],fixture:directory}));
}finally{clearTimeout(watchdog);await router.releaseOwner('owner');await context?.close();await service.close();key?.fill(0);await new Promise(resolve=>server.close(resolve));}
