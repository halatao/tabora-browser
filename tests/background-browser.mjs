// Product execution goes through MCP + the real extension. Playwright only sets up and judges.
import {createServer} from 'node:http';
import {mkdir,mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {spawn} from 'node:child_process';

const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'background-'));
const extension=path.join(directory,'extension'),state=path.join(directory,'state'),writes=[],checks=[],samples=[];let context,client,browser,browserProcess;
const fixture=`<!doctype html><title>Background interaction</title><style>button,input{margin:8px}#board{position:relative;width:320px;height:160px}canvas{width:320px;height:160px}#private{position:absolute;left:180px;top:20px;width:110px}#drop{width:200px;height:50px;background:#ddd}</style>
<button id="dom">DOM save</button><button id="native">Native save</button><label>Editor<input id="editor"></label><button id="hover">Hover menu</button><button id="revealed" hidden>Revealed action</button>
<div draggable="true" role="listitem" aria-label="Movable record" id="source">Record</div><div id="drop" role="region" aria-label="Drop destination">Drop here</div>
<div role="img" aria-label="Visual board" id="board"><canvas width="320" height="160"></canvas><input type="password" value="synthetic-private-value" id="private"></div>
<a href="/next">Continue</a><p role="status" aria-label="Result">Ready</p>
<script>
const status=document.querySelector('p'),editor=document.querySelector('#editor'),canvas=document.querySelector('canvas');const ctx=canvas.getContext('2d');ctx.fillStyle='#00ff00';ctx.fillRect(0,0,320,160);
function record(kind,event){if(document.hidden||!document.hasFocus())return;requestAnimationFrame(()=>requestAnimationFrame(async()=>{const body={kind,trusted:event.isTrusted,visible:!document.hidden,focused:document.hasFocus(),value:editor.value};status.textContent=await(await fetch('/write',{method:'POST',body:JSON.stringify(body)})).text();}));}
document.querySelector('#dom').onclick=e=>record('dom',e);
document.querySelector('#native').onclick=e=>{if(e.isTrusted)record('native',e);};
editor.onkeydown=e=>{if(e.key==='Enter'&&e.isTrusted)record('key',e);};
document.querySelector('#hover').onpointerover=e=>{if(e.isTrusted&&!document.hidden&&document.hasFocus())document.querySelector('#revealed').hidden=false;};
document.querySelector('#source').ondragstart=e=>e.dataTransfer.setData('text/plain','Record');
document.querySelector('#drop').ondragover=e=>e.preventDefault();document.querySelector('#drop').ondrop=e=>{e.preventDefault();if(e.isTrusted&&e.dataTransfer.getData('text/plain')==='Record')record('drag',e);};
canvas.onclick=e=>{if(e.isTrusted)record('canvas',e);};
</script>`;
const server=createServer((req,res)=>{
  if(req.url==='/write'&&req.method==='POST'){let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{writes.push(JSON.parse(body));res.end('Saved '+writes.length);});return;}
  res.writeHead(200,{'content-type':'text/html'}).end(req.url==='/next'?'<title>Destination</title><h1>Navigation completed</h1>':fixture);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const watchdog=setTimeout(()=>{console.error('Background integration timed out');process.exit(1);},180000);
try{
  await cp('dist/extension',extension,{recursive:true});const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));manifest.host_permissions=['http://127.0.0.1/*'];await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
  // Launch plain Chromium: no Playwright focus override or global background-throttling flags.
  const profilePath=path.join(directory,'chromium');await mkdir(profilePath);
  browserProcess=spawn(chromium.executablePath(),[`--user-data-dir=${profilePath}`,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--no-first-run','--no-default-browser-check','--window-size=1000,800',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,...(process.env.TABORA_BACKGROUND_HEADFUL==='1'?[]:['--headless=new'])],{windowsHide:true,stdio:'ignore',env:{...process.env,TABORA_STATE_DIR:state}});
  let port;for(let retry=0;retry<100;retry++){try{port=Number((await readFile(path.join(profilePath,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
  assert(port,'Isolated Chromium debugging port unavailable');
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{noDefaults:true});context=browser.contexts()[0];
  const panel=await context.newPage(),extensionId=(await readFile('extension-id.txt','utf8')).trim();await panel.goto(`chrome-extension://${extensionId}/panel.html`);await panel.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Lokální host připojený');
  const profileId=(await panel.evaluate(()=>chrome.runtime.sendMessage({command:'status'}))).data.profile.id;
  client=new Client({name:'background-integration',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/host/mcp.js')],env:{...process.env,TABORA_STATE_DIR:state},stderr:'ignore'}));
  const tool=async(name,args={},expected)=>{const reply=await client.callTool({name,arguments:args}),data=JSON.parse(reply.content.find(block=>block.type==='text').text);if(expected){assert(reply.isError,JSON.stringify(data));assert.equal(data.code,expected);}else assert(!reply.isError,`${name}: ${JSON.stringify(data)}`);return data;};
  const session=await tool('browser_session_create',{profileId,name:'Background regression',allowedOrigins:[origin]});
  const opened=await tool('browser_session_open',{sessionId:session.id,url:origin,active:false,waitForReady:true});assert(opened.attached);
  const page=context.pages().find(page=>page.url()===origin+'/');assert(page);
  // Playwright enables this override by default. Disable it, and prove actual hidden state first.
  const setupCdp=await context.newCDPSession(page);await setupCdp.send('Emulation.setFocusEmulationEnabled',{enabled:false});
  const witness=await context.newPage();await witness.setContent('<title>Unrelated user tab</title><input aria-label="User editor" value="untouched">');await witness.bringToFront();await witness.getByRole('textbox').focus();
  const witnessId=await panel.evaluate(()=>chrome.tabs.query({active:true,lastFocusedWindow:true}).then(tabs=>tabs[0].id));
  await panel.evaluate(()=>{globalThis.activations=[];chrome.tabs.onActivated.addListener(info=>globalThis.activations.push(info.tabId));});
  assert.equal(await page.evaluate(()=>document.hidden),true,'Fixture must really start hidden; no harness focus emulation');
  const observe=()=>tool('browser_state',{sessionId:session.id});
  const target=(observation,name)=>{const matches=observation.snapshot.targets.filter(target=>target.name===name);assert.equal(matches.length,1,name);return matches[0];};
  const commit=async(action,expect)=>{
    const observation=await observe(),plan=await tool('browser_plan',{sessionId:session.id,stateVersion:observation.stateVersion,action:action(observation),expect,timeoutMs:3000});
    return tool('browser_commit',{sessionId:session.id,actionId:plan.actionId,stateVersion:plan.stateVersion});
  };
  const remainsBackground=async(minimized=false)=>{
    assert.equal(await panel.evaluate(id=>chrome.tabs.get(id).then(tab=>tab.active),opened.tabId),false);
    assert.equal(await panel.evaluate(()=>chrome.tabs.query({active:true,currentWindow:true}).then(tabs=>tabs[0].id)),witnessId);
    assert.deepEqual(await panel.evaluate(()=>globalThis.activations),[],'No intermediate focus theft/restore allowed');
    assert.equal(await witness.getByRole('textbox').inputValue(),'untouched');
    assert.equal(await page.evaluate(()=>document.hidden),true,'Temporary emulation must be cleaned up');
    if(minimized)assert.equal(await panel.evaluate(id=>chrome.windows.get(id).then(window=>window.state),opened.windowId),'minimized');
  };
  const save=async(kind,action,capturedState)=>{
    const before=writes.length,observation=capturedState??await observe(),resultTarget=target(observation,'Result');
    const plan=await tool('browser_plan',{sessionId:session.id,stateVersion:observation.stateVersion,action:action(observation),expect:{type:'text',targetId:resultTarget.id,contains:'Saved '+(before+1)}});
    const start=performance.now(),result=await tool('browser_commit',{sessionId:session.id,actionId:plan.actionId,stateVersion:plan.stateVersion});
    assert.equal(result.readiness.state,'verified',JSON.stringify(result));assert.equal(writes.length,before+1);const write=writes.at(-1);assert.equal(write.kind,kind);assert(write.visible&&write.focused);if(kind!=='dom')assert(write.trusted);
    return {wallMs:Math.round((performance.now()-start)*100)/100,executorMs:result.timings.totalMs,phases:result.timings};
  };
  await save('dom',observation=>({type:'click',targetId:target(observation,'DOM save').id}));await remainsBackground();checks.push('DOM action + visibility/focus guard + double rAF readiness without tab activation');
  await save('native',observation=>({type:'click',targetId:target(observation,'Native save').id,backend:'native'}));await remainsBackground();checks.push('trusted native click in hidden tab reaches independent server exactly once');
  await commit(observation=>({type:'fill',targetId:target(observation,'Editor').id,value:'background text',backend:'native'}));
  await save('key',observation=>({type:'key',targetId:target(observation,'Editor').id,key:'Enter'}));assert.equal(writes.at(-1).value,'background text');await remainsBackground();checks.push('trusted text/key input targets only the observed element; user editor unchanged');
  const hovered=await commit(observation=>({type:'hover',targetId:target(observation,'Hover menu').id}));assert(target(hovered,'Revealed action'));await remainsBackground();checks.push('trusted hover reveals background controls');
  await save('drag',observation=>({type:'drag',targetId:target(observation,'Movable record').id,destinationId:target(observation,'Drop destination').id}));await remainsBackground();checks.push('trusted HTML drag/drop in inactive tab');
  const imageState=await observe(),board=target(imageState,'Visual board'),capture=await tool('browser_capture',{sessionId:session.id,targetId:board.id,stateVersion:imageState.stateVersion});
  const preview=await client.callTool({name:'browser_image_view',arguments:{sessionId:session.id,artifactId:capture.artifact.id}});assert(!preview.isError);const image=preview.content.find(block=>block.type==='image'),decoded=await loadImage(Buffer.from(image.data,'base64')),canvas=createCanvas(decoded.width,decoded.height),ctx=canvas.getContext('2d');ctx.drawImage(decoded,0,0);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
  const pixel=(x,y)=>Array.from(pixels.slice((y*canvas.width+x)*4,(y*canvas.width+x)*4+3));assert(pixel(Math.round(40*canvas.width/320),Math.round(60*canvas.height/160))[1]>230,'Screenshot must contain target pixels, not active witness tab');assert(pixel(Math.round(240*canvas.width/320),Math.round(40*canvas.height/160)).every(value=>value<15),'Private field must remain blacked out: '+JSON.stringify({width:canvas.width,height:canvas.height,visual:capture.visual,pixel:pixel(Math.round(240*canvas.width/320),Math.round(40*canvas.height/160))}));await remainsBackground();
  await save('canvas',()=>({type:'image_click',targetId:board.id,captureId:capture.visual.captureId,x:40,y:60}),imageState);await remainsBackground();checks.push('target-only screenshot, password pixel masks and capture-bound image click');
  // Another debugger lease, even from this extension, must remain attached on failure.
  await panel.evaluate(id=>chrome.debugger.attach({tabId:id},'1.3'),opened.tabId);
  try{
    const observation=await observe(),plan=await tool('browser_plan',{sessionId:session.id,stateVersion:observation.stateVersion,action:{type:'click',targetId:target(observation,'Native save').id,backend:'native'}}),before=writes.length;
    await tool('browser_commit',{sessionId:session.id,actionId:plan.actionId,stateVersion:plan.stateVersion},'background_debugger_unavailable');assert.equal(writes.length,before);
    assert(await panel.evaluate(id=>chrome.debugger.getTargets().then(targets=>targets.some(target=>target.tabId===id&&target.attached)),opened.tabId));
  }finally{await panel.evaluate(id=>chrome.debugger.detach({tabId:id}),opened.tabId);}
  await remainsBackground();checks.push('competing debugger fails before write and is never detached by executor');
  await panel.evaluate(id=>chrome.windows.update(id,{state:'minimized'}),opened.windowId);
  await save('native',observation=>({type:'click',targetId:target(observation,'Native save').id,backend:'native'}));await remainsBackground(true);checks.push('native action + rAF readiness in minimized window without restoring it');
  await panel.evaluate(id=>chrome.windows.update(id,{state:'normal'}),opened.windowId);
  // Balanced warm executor comparison, excluding setup/observation/decision inference. Same page/model-free lane.
  for(let pair=0;pair<6;pair++)for(const mode of pair%2?['background','active']:['active','background']){
    await panel.evaluate(id=>chrome.tabs.update(id,{active:true}),mode==='active'?opened.tabId:witnessId);
    const timing=await save('native',observation=>({type:'click',targetId:target(observation,'Native save').id,backend:'native'}));samples.push({pair,mode,...timing});
  }
  await panel.evaluate(id=>chrome.tabs.update(id,{active:true}),witnessId);await panel.evaluate(()=>globalThis.activations=[]);
  const navigated=await commit(observation=>({type:'click',targetId:target(observation,'Continue').id,backend:'native'}));assert.equal(navigated.snapshot.path,'/next');assert.notEqual(navigated.binding.documentId,imageState.binding.documentId);await remainsBackground();checks.push('native navigation rebinds exact owned document in background');
  await setupCdp.detach();await tool('browser_session_release',{sessionId:session.id});
  const median=values=>{const sorted=values.toSorted((a,b)=>a-b);return (sorted[Math.floor((sorted.length-1)/2)]+sorted[Math.floor(sorted.length/2)])/2;};
  const report={passed:true,kind:'background_executor_integration',extensionVersion:manifest.version,headless:process.env.TABORA_BACKGROUND_HEADFUL!=='1',browser:browser.version(),checks,samples,summary:Object.fromEntries(['active','background'].map(mode=>{const values=samples.filter(sample=>sample.mode===mode);return [mode,{runs:values.length,medianWallMs:median(values.map(value=>value.wallMs)),medianExecutorMs:median(values.map(value=>value.executorMs))}];})),scope:'Matched warm real extension/MCP executor; no model inference, not an external agent benchmark'};
  await mkdir('reports/background',{recursive:true});await writeFile('reports/background/latest.json',JSON.stringify(report,null,2));await writeFile(`reports/background/${report.headless?'headless':'headed'}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{
  clearTimeout(watchdog);await client?.close().catch(()=>{});
  if(browser){const cleanup=await browser.newBrowserCDPSession().catch(()=>undefined);await cleanup?.send('Browser.close').catch(()=>{});await browser.close().catch(()=>{});}
  if(browserProcess){await new Promise(resolve=>{if(browserProcess.exitCode!==null)return resolve();browserProcess.once('exit',resolve);browserProcess.kill();});}
  await new Promise(resolve=>server.close(resolve));assert.equal(path.dirname(directory),base);await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
