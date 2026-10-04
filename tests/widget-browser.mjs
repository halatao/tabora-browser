// Integration assertions drive typed MCP operations; this is not a model benchmark.
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,cp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {executeWorkflow} from '../src/host/workflow.ts';
import {PilotError} from '../src/shared.ts';
import {workflowSchema} from '../src/browser-api.ts';
await mkdir('.test-state',{recursive:true});const directory=await mkdtemp(path.resolve('.test-state/workflow-')),state=path.join(directory,'state'),extension=path.join(directory,'extension'),judge=path.join(directory,'judge');
const server=spawn('python',['-X','utf8',path.resolve('../browser-capability-bench/suite.py'),'serve','--judge-dir',judge,'--workspace',path.join(directory,'workspace'),'--seed','101'],{windowsHide:true,stdio:['ignore','pipe','ignore']});
const info=await new Promise((resolve,reject)=>{let output='';const timeout=setTimeout(()=>reject(Error('fixture_startup_timeout')),15000);server.stdout.on('data',data=>{output+=data;const end=output.indexOf('\n');if(end>=0){clearTimeout(timeout);resolve(JSON.parse(output.slice(0,end)));}});server.once('error',reject);});
await cp('dist/extension',extension,{recursive:true});const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));manifest.host_permissions=['http://127.0.0.1/*'];await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
let context,client;const timeout=setTimeout(()=>{console.error('Workflow integration timeout');process.exit(1);},120000);
try{
  context=await chromium.launchPersistentContext(path.join(directory,'chromium'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],env:{...process.env,TABORA_STATE_DIR:state}});
  const panel=await context.newPage(),extensionId=(await readFile('extension-id.txt','utf8')).trim();await panel.goto(`chrome-extension://${extensionId}/panel.html`);await panel.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Lokální host připojený');const profileId=(await panel.evaluate(()=>chrome.runtime.sendMessage({command:'status'}))).data.profile.id;await panel.close();
  client=new Client({name:'workflow-integration',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/host/mcp.js')],env:{...process.env,TABORA_STATE_DIR:state},stderr:'ignore'}));
  async function tool(name,args={}){const reply=await client.callTool({name,arguments:args}),result=JSON.parse(reply.content.find(part=>part.type==='text').text);if(reply.isError)throw new PilotError(result.code);return result;}
  const session=await tool('browser_session_create',{profileId,name:'Widget and paragraphs',allowedOrigins:[info.public_url]});const sessionId=session.id;
  await tool('browser_session_open',{sessionId,url:info.public_url+'/task/BCB-C05-V04',active:true,waitForReady:true});
  const page=context.pages().find(page=>page.url().endsWith('/task/BCB-C05-V04'));
  let observation=await tool('browser_state',{sessionId});

  const combo=observation.snapshot.targets.find(target=>target.kind==='combobox'&&target.visible&&target.name==='Shipping');assert(combo,'Named combobox must be discovered');
  let plan=await tool('browser_plan',{sessionId,stateVersion:observation.stateVersion,action:{type:'click',targetId:combo.id,backend:'native'}});await tool('browser_commit',{sessionId,actionId:plan.actionId,stateVersion:plan.stateVersion});
  observation=await tool('browser_state',{sessionId});const option=observation.snapshot.targets.find(target=>target.kind==='option'&&target.name==='Express'&&target.visible);assert(option,JSON.stringify(observation.snapshot.targets));
  plan=await tool('browser_plan',{sessionId,stateVersion:observation.stateVersion,action:{type:'click',targetId:option.id,backend:'native'}});await tool('browser_commit',{sessionId,actionId:plan.actionId,stateVersion:plan.stateVersion});assert.equal(await page.locator('#shipping').inputValue(),'Express');
  await tool('browser_session_release',{sessionId});
  const editing=await tool('browser_session_create',{profileId,name:'Partial paragraph',allowedOrigins:[info.public_url]});await tool('browser_session_open',{sessionId:editing.id,url:info.public_url+'/task/BCB-C08-V01',active:true,waitForReady:true});
  observation=await tool('browser_state',{sessionId:editing.id});const editor=observation.snapshot.targets.find(target=>target.name==='Customer'&&target.inputType==='contenteditable');assert(editor);assert.equal(editor.value,'Old first paragraph\n\nOld second paragraph');
  plan=await tool('browser_plan',{sessionId:editing.id,stateVersion:observation.stateVersion,action:{type:'replace',targetId:editor.id,start:0,end:19,text:'Nový první odstavec'}});const changed=await tool('browser_commit',{sessionId:editing.id,actionId:plan.actionId,stateVersion:plan.stateVersion});assert.equal(changed.action.outcome,'verified',JSON.stringify(changed));
  observation=await tool('browser_state',{sessionId:editing.id});assert.equal(observation.snapshot.targets.find(target=>target.name==='Customer').value,'Nový první odstavec\n\nOld second paragraph');await tool('browser_session_release',{sessionId:editing.id});
  const multiline=await tool('browser_session_create',{profileId,name:'Multiline paragraph',allowedOrigins:[info.public_url]});await tool('browser_session_open',{sessionId:multiline.id,url:info.public_url+'/task/BCB-C08-V02',active:true,waitForReady:true});
  observation=await tool('browser_state',{sessionId:multiline.id});const multilineEditor=observation.snapshot.targets.find(target=>target.name==='Customer'&&target.inputType==='contenteditable');
  const text='Nový text <img src=x onerror=alert(1)>\nPříliš žluťoučký kůň';
  plan=await tool('browser_plan',{sessionId:multiline.id,stateVersion:observation.stateVersion,action:{type:'replace',targetId:multilineEditor.id,start:0,end:multilineEditor.value.length,text}});const paste=await tool('browser_commit',{sessionId:multiline.id,actionId:plan.actionId,stateVersion:plan.stateVersion});assert.equal(paste.action.outcome,'verified',JSON.stringify(paste));
  const read=await tool('browser_read',{sessionId:multiline.id,targetId:multilineEditor.id,format:'text'});assert.equal(read.text,text);assert.equal(await context.pages().find(page=>page.url().endsWith('/task/BCB-C08-V02')).locator('[contenteditable] img').count(),0);await tool('browser_session_release',{sessionId:multiline.id});
  const slotted=await tool('browser_session_create',{profileId,name:'Closed composed slots',allowedOrigins:[info.public_url]});await tool('browser_session_open',{sessionId:slotted.id,url:info.public_url+'/task/BCB-C15-V03',active:true,waitForReady:true});
  observation=await tool('browser_state',{sessionId:slotted.id});const slottedSave=observation.snapshot.targets.find(target=>target.name==='Save customer'&&target.kind==='button');assert(slottedSave,'Nested slot button must be observed');
  plan=await tool('browser_plan',{sessionId:slotted.id,stateVersion:observation.stateVersion,action:{type:'click',targetId:slottedSave.id,backend:'native'}});const slotClick=await tool('browser_commit',{sessionId:slotted.id,actionId:plan.actionId,stateVersion:plan.stateVersion});assert.equal(slotClick.action.dispatch,'sent',JSON.stringify(slotClick));const slotPage=context.pages().find(page=>page.url().endsWith('/task/BCB-C15-V03'));await slotPage.waitForFunction(()=>document.querySelector('#receipt').textContent.startsWith('Saved'));await tool('browser_session_release',{sessionId:slotted.id});
  console.log(JSON.stringify({passed:true,checks:['real pinned widget discovery matches AX','portal option native input','partial paragraph edit preserves unrelated content','multiline Unicode paste preserves literal markup and exact rendered text','native hit testing follows slots inside nested closed roots']}));
}finally{clearTimeout(timeout);await client?.close().catch(()=>{});await context?.close();server.kill();}
