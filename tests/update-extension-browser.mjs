import './require-source-host.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,mkdtemp,cp,copyFile,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {atomicJson} from '../scripts/distribution/files.mjs';
const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'update-browser-'));
const build=JSON.parse(await readFile('dist/build-info.json','utf8')),id=build.version+'-'+build.fingerprint.slice(0,16),extensionId=(await readFile('extension-id.txt','utf8')).trim();
const root=path.join(directory,'app'),version=path.join(root,'versions',id),state=path.join(directory,'state'),extension=path.join(root,'extension-unpacked');
let count=0,context,client,peer,cdp;const workerErrors=[];
const server=createServer((req,res)=>{if(req.url==='/clicked'){count++;res.end('ok');return;}res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Update lifecycle fixture</title><button onclick="fetch(\'/clicked\')">Count once</button>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
try{
  await mkdir(path.join(version,'runtime'),{recursive:true});await copyFile(process.execPath,path.join(version,'runtime/node.exe'));
  await cp('dist/host',path.join(version,'dist/host'),{recursive:true});await cp('dist/extension',extension,{recursive:true});
  const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));manifest.host_permissions=['http://127.0.0.1/*'];await atomicJson(path.join(extension,'manifest.json'),manifest);
  const installationId=randomUUID();await atomicJson(path.join(root,'installation.json'),{schema:1,product:'tabora-browser',id:installationId,current:id,stateDir:state,requestedStateDir:state,extensionId,installKind:'unpacked',policy:'notify',sequence:0});
  await atomicJson(path.join(version,'release-trust.json'),{schema:1,keys:[]});
  process.env.TABORA_INSTALL_ROOT=root;process.env.TABORA_STATE_DIR=state;
  const env={...process.env,TABORA_BROWSER_NAME:'Update lifecycle fixture',TABORA_UPDATE_CHECK:'0'};
  context=await chromium.launchPersistentContext(path.join(directory,'chromium'),{channel:'chromium',headless:true,env,args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
  const developerPage=await context.newPage();await developerPage.goto('chrome://extensions');
  const developerToggle=developerPage.locator('cr-toggle#devMode');
  if(await developerToggle.getAttribute('aria-pressed')!=='true')await developerToggle.click();
  await developerPage.close();
  cdp=await context.newCDPSession(context.pages()[0]);await cdp.send('ServiceWorker.enable');cdp.on('ServiceWorker.workerErrorReported',event=>workerErrors.push(event.errorMessage.errorMessage));
  client=new Client({name:'update-lifecycle-fixture',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/host/mcp.js')],env,stderr:'ignore'}));
  const tool=async(name,args={})=>{const response=await client.callTool({name,arguments:args});if(response.isError)throw new Error(response.content[0].text);return JSON.parse(response.content[0].text);};
  const profiles=async()=>{
    for(let i=0;i<150;i++){const list=await tool('browser_profiles');if(list.length)return list;await new Promise(resolve=>setTimeout(resolve,200));}
    const diagnostics=await Promise.all(context.serviceWorkers().map(worker=>worker.evaluate(async()=>{
      const profile=(await chrome.storage.local.get('profile')).profile;
      return {profileId:profile?.id,mcpEnabled:profile?.mcpEnabled,native:await new Promise(resolve=>{
        const port=chrome.runtime.connectNative('com.tabora.browser');const timer=setTimeout(()=>{port.disconnect();resolve('timeout');},5000);
        port.onMessage.addListener(message=>{clearTimeout(timer);resolve(message.ok?'hello_ok':message.code);port.disconnect();});
        port.onDisconnect.addListener(()=>{clearTimeout(timer);resolve(chrome.runtime.lastError?.message??'disconnected');});
        port.postMessage({id:crypto.randomUUID(),version:1,command:'hello',payload:{id:crypto.randomUUID(),name:'Lifecycle diagnostic',mcpEnabled:false}});
      })};
    }).catch(()=>({worker:'unavailable'}))));
    const targets=(await cdp.send('Target.getTargets')).targetInfos.filter(target=>target.type==='service_worker').map(target=>({url:target.url,attached:target.attached}));
    const debugPage=await context.newPage();await debugPage.goto('chrome://extensions');
    const extensions=await debugPage.evaluate(()=>new Promise(resolve=>chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true},items=>resolve(items.map(item=>({id:item.id,state:item.state,disableReasons:item.disableReasons,runtimeErrors:item.runtimeErrors?.map(error=>error.message)})))))).catch(()=>[]);
    throw new Error('Extension reconnect failed: '+JSON.stringify({diagnostics,workerErrors,targets,extensions}));
  };
  const [profile]=await profiles(),session=await tool('browser_session_create',{profileId:profile.id,name:'Update fixture'});
  await tool('browser_session_open',{sessionId:session.id,url:origin,active:true,waitForReady:true});
  const observed=await tool('browser_state',{sessionId:session.id}),button=observed.snapshot.targets.find(target=>target.name==='Count once');assert(button);
  const plan=await tool('browser_plan',{sessionId:session.id,stateVersion:observed.stateVersion,action:{type:'click',targetId:button.id,backend:'dom'}});
  const job=randomUUID();await atomicJson(path.join(state,'updates',job,'journal.json'),{schema:1,installationId,id:job,status:'scheduled',ticketHash:'0'.repeat(64),createdAt:Date.now()});
  const {connectPipe}=await import('../src/host/ipc.ts'),{DpapiProtector}=await import('../src/host/vault.ts');
  const token=await new DpapiProtector(path.resolve('dist/host/dpapi.ps1')).unprotect(await readFile(path.join(state,'broker-auth.bin')));
  peer=await connectPipe('\\\\.\\pipe\\tabora-browser-'+createHash('sha256').update(state.toLowerCase()).digest('hex').slice(0,32));await peer.call('ready');
  try{await peer.call('authenticate',{role:'mcp',token:token.toString(),fileRoots:[]});}finally{token.fill(0);}
  const preparation=await peer.call('maintenance.prepare',{updateId:job});assert(preparation.ready);assert.deepEqual(preparation.profiles,[profile.id]);
  await assert.rejects(tool('browser_commit',{sessionId:session.id,actionId:plan.actionId,stateVersion:observed.stateVersion}),/update_maintenance/);assert.equal(count,0);
  const nextVersion=manifest.version.split('.').map(Number);nextVersion[2]++;
  await atomicJson(path.join(extension,'manifest.json'),{...manifest,version:nextVersion.join('.')});
  await peer.call('maintenance.finish',{updateId:job}).catch(error=>{assert.equal(error.code,'connection_lost');});peer.close();peer=undefined;
  const [reconnected]=await profiles();assert.equal(reconnected.id,profile.id,'reload preserves profile UUID');assert.equal(reconnected.vaultEnabled,false);
  await assert.rejects(tool('browser_commit',{sessionId:session.id,actionId:plan.actionId,stateVersion:observed.stateVersion}),/session_not_owned|session_interrupted/);assert.equal(count,0,'pending write was never replayed');
  console.log('PASS: real Chromium extension seals maintenance, rejects a pending click before dispatch, reloads through the flushed native event, reconnects to a new broker, preserves profile UUID/vault-off and invalidates the old plan. No user registry/profile changed.');
}finally{
  peer?.close();await client?.close().catch(()=>{});await context?.close().catch(()=>{});await new Promise(resolve=>server.close(resolve));
  await new Promise(resolve=>setTimeout(resolve,3500));assert(directory.startsWith(base+path.sep));await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:300});
}
