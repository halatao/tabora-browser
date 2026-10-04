// Real extension input/capture integration with a synthetic decision sink, no paid model.
import {createServer} from 'node:http';
import {mkdir,mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {RunController} from '../src/host/run-controller.ts';
import {workflowSchema} from '../src/browser-api.ts';
import {requestSchema} from '../src/shared.ts';
import {decisionEnvelope} from '../src/host/codex-proxy.ts';
const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'visual-workflow-'));
const state=path.join(directory,'state'),extension=path.join(directory,'extension');let commits=0,context,client;
const fixture=createServer((req,res)=>{
  if(req.url==='/commit'){commits++;res.end('Saved');return;}
  res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><title>Visual workflow regression</title><canvas role="img" aria-label="Illustration" tabindex="0" width="180" height="90"></canvas><input type="password" value="synthetic-private-value"><button disabled>Commit change</button><p role="status" aria-label="Result">Ready</p><script>const canvas=document.querySelector("canvas"),ctx=canvas.getContext("2d");ctx.fillStyle="red";ctx.fillRect(0,0,90,90);let pressed=false;const button=document.querySelector("button");canvas.onclick=e=>{if(e.isTrusted)button.disabled=false;};button.addEventListener("pointerdown",e=>pressed=e.isTrusted);button.addEventListener("pointerup",async e=>{if(pressed&&e.isTrusted)document.querySelector("p").textContent=await(await fetch("/commit")).text();pressed=false;});</script>');
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${fixture.address().port}`;
try{
  await cp('dist/extension',extension,{recursive:true});const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));manifest.host_permissions=['http://127.0.0.1/*'];await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
  context=await chromium.launchPersistentContext(path.join(directory,'chromium'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],env:{...process.env,TABORA_STATE_DIR:state}});
  const panel=await context.newPage(),extensionId=(await readFile('extension-id.txt','utf8')).trim();await panel.goto(`chrome-extension://${extensionId}/panel.html`);await panel.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Lokální host připojený');const profileId=(await panel.evaluate(()=>chrome.runtime.sendMessage({command:'status'}))).data.profile.id;await panel.close();
  client=new Client({name:'visual-regression',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/host/mcp.js')],env:{...process.env,TABORA_STATE_DIR:state},stderr:'ignore'}));
  const tool=async(name,args={})=>{const reply=await client.callTool({name,arguments:args}),data=JSON.parse(reply.content.find(block=>block.type==='text').text);if(reply.isError){console.error('Visual integration tool failed:',name,data.code);assert.fail(name+': '+data.code);}return data;};
  const session=await tool('browser_session_create',{profileId,name:'Visual regression',allowedOrigins:[origin]});const opened=await tool('browser_session_open',{sessionId:session.id,url:origin,active:true,waitForReady:true});
  const worker=context.serviceWorkers()[0];
  // Advance only the mask's five-second expiry clock. No real-time race or private data inspection.
  await worker.evaluate(async tabId=>{
    await chrome.scripting.executeScript({target:{tabId},func:()=>{
      const nativeSet=globalThis.setTimeout.bind(globalThis),nativeClear=globalThis.clearTimeout.bind(globalThis);
      const clock={now:0,next:-1,events:new Map(),advance(now){this.now=now;for(const [id,event] of [...this.events])if(event.at<=now){this.events.delete(id);event.callback();}}};
      globalThis.__captureTestClock=clock;
      globalThis.setTimeout=(callback,ms,...args)=>{if(ms!==5000)return nativeSet(callback,ms,...args);const id=clock.next--;clock.events.set(id,{at:clock.now+ms,callback:()=>callback(...args)});return id;};
      globalThis.clearTimeout=id=>{clock.events.delete(id);nativeClear(id);};
    }});
    const original=chrome.debugger.sendCommand.bind(chrome.debugger);let captures=0;
    chrome.debugger.sendCommand=async(target,method,params)=>{
      if(method==='Page.captureScreenshot'&&++captures===2)await chrome.scripting.executeScript({target:{tabId},func:()=>globalThis.__captureTestClock.advance(5000)});
      return original(target,method,params);
    };
  },opened.tabId);
  let captureCount=0;
  const controller=new RunController();let decisionCount=0,lastCommand;
  const run=controller.start('fixture',profileId,session.id,'typesafe-jev','Use the visible illustration to commit the change',async(command,payload)=>{
    lastCommand=command;
    if(command==='status')return {configs:[{provider:'codex-sdk',model:'gpt-5.5',timeoutMs:30000}]};
    if(command==='workflow.capture'){
      if(++captureCount===2)await worker.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>globalThis.__captureTestClock.advance(1500)}),opened.tabId);
      const capture=await tool('browser_capture',{sessionId:session.id,...payload});const preview=await client.callTool({name:'browser_image_view',arguments:{sessionId:session.id,artifactId:capture.artifact.id}});assert(!preview.isError);const image={...JSON.parse(preview.content.find(block=>block.type==='text').text),...preview.content.find(block=>block.type==='image')};await tool('browser_files_release',{sessionId:session.id,artifactIds:[capture.artifact.id]});
      return {data:image.data,mimeType:image.mimeType,width:image.width,height:image.height,targetId:payload.targetId,stateVersion:payload.stateVersion,captureId:capture.visual.captureId,expiresAt:capture.visual.expiresAt};
    }
    if(command==='select'){
      decisionCount++;assert.equal(payload.provider,'codex-sdk');requestSchema.parse(payload.request);assert.equal(payload.request.images.length,1);assert(!JSON.stringify(payload.request.context).includes('synthetic-private-value'));
      const wire=decisionEnvelope({model:'gpt-5.5'},payload.request,'gpt-5.5');assert.equal(wire.input[0].content[1].type,'input_image');
      const chosen=payload.request.choices.find(choice=>choice.description.startsWith('Activate button: Commit change'))??payload.request.choices.find(choice=>choice.description.startsWith('Activate img: Illustration'));
      assert(chosen,'A JavaScript property click handler must be offered as a native action');
      return {status:'selected',choiceId:chosen.id,provider:'codex-sdk',model:'gpt-5.5',latencyMs:0};
    }
    const names={'v2.capabilities':'browser_capabilities','v2.frames':'browser_frames','v2.state':'browser_state','v2.read':'browser_read','v2.plan':'browser_plan','v2.commit':'browser_commit'};assert(names[command],command);
    return tool(names[command],{sessionId:session.id,...payload});
  },{readonly:false,maxSteps:5,timeoutMs:15000,workflow:workflowSchema.parse({visual:{provider:'codex-sdk'},success:{name:'Result',contains:'Saved'}})});
  for(let i=0;i<300&&controller.status('fixture',run.id).status==='running';i++)await new Promise(resolve=>setTimeout(resolve,50));
  const result=controller.status('fixture',run.id);
  assert.equal(result.status,'completed',JSON.stringify({result,lastCommand}));assert.equal(commits,1);assert.equal(decisionCount,2);assert.equal(result.trace[0].actionType,'click');assert.equal(result.trace[0].targetKind,'img');assert.equal(result.trace[0].provider,'codex-sdk');assert.equal(result.trace[0].modality,'vision');
  assert(!JSON.stringify(result).includes('base64'));await tool('browser_session_release',{sessionId:session.id});
  console.log(JSON.stringify({passed:true,checks:['default native backend through real extension','focusable canvas with a page-world property listener is offered and clicked natively','trusted pointer events commit exactly once','bounded clip capture preserves page layout and privacy validation','previous mask expiry cannot erase a subsequent capture','redacted capture traverses workflow and image wire envelope','explicit Jev/text + Codex/image selection recorded','completion checked after server response'],scope:'synthetic provider; real model tested separately'}));
}finally{await client?.close().catch(()=>{});await context?.close();await new Promise(resolve=>fixture.close(resolve));assert.equal(path.dirname(directory),base);await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
