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
  const session=await tool('browser_session_create',{profileId,name:'PDF pipeline',allowedOrigins:[info.public_url]});const sessionId=session.id;await tool('browser_session_open',{sessionId,url:info.public_url+'/task/W05',active:true,waitForReady:true});
  const observe=()=>tool('browser_state',{sessionId});let observation=await observe();
  const target=(name)=>{const matches=observation.snapshot.targets.filter(target=>target.name===name);assert.equal(matches.length,1,JSON.stringify(observation.snapshot.targets.map(target=>({name:target.name,kind:target.kind,value:target.value}))));return matches[0];};
  const artifact=(await tool('browser_download',{sessionId,stateVersion:observation.stateVersion,targetId:target('Invoice').id,name:'invoice.pdf'})).artifact;
  const document=await tool('browser_document_read',{sessionId,artifactId:artifact.id,format:'pdf',page:2});const value=document.text.split('\n').find(line=>line.startsWith('Reference: ')).slice('Reference: '.length).trimEnd();
  observation=await observe();const plan=await tool('browser_plan',{sessionId,stateVersion:observation.stateVersion,action:{type:'fill',targetId:target('Customer').id,value,backend:'native'}});const filled=await tool('browser_commit',{sessionId,actionId:plan.actionId,stateVersion:plan.stateVersion});assert.equal(filled.action.outcome,'verified',JSON.stringify(filled.action));
  observation=await observe();assert.equal(target('Customer').value,value);assert.equal(target('Invoice attachment').kind,'file');
  await tool('browser_upload',{sessionId,stateVersion:observation.stateVersion,targetId:target('Invoice attachment').id,artifactIds:[artifact.id]});
  observation=await observe();const save=await tool('browser_plan',{sessionId,stateVersion:observation.stateVersion,action:{type:'click',targetId:target('Save').id,backend:'native'}});await tool('browser_commit',{sessionId,actionId:save.actionId,stateVersion:save.stateVersion});
  const page=context.pages().find(page=>page.url()===info.public_url+'/task/W05');await page.waitForFunction(()=>document.querySelector('#receipt').textContent.startsWith('Saved'));
  const oracle=JSON.parse(await readFile(path.join(judge,'world-oracle.json'),'utf8')).cases.W05;assert.equal(oracle.events.length,1);assert.deepEqual(oracle.events[0].data,oracle.expected);assert.equal(oracle.workflow_uploads.length,1);assert.equal(oracle.workflow_uploads[0][0].name,'invoice.pdf');
  await tool('browser_session_release',{sessionId});
  const tasks=await (await fetch(info.public_url+'/tasks')).json(),task=tasks.find(task=>task.id==='W05');
  const second=await tool('browser_session_create',{profileId,name:'PDF controller',allowedOrigins:[info.public_url]});await tool('browser_session_open',{sessionId:second.id,url:info.public_url+'/task/W05',active:true,waitForReady:true});
  const outcome={id:'test',sessionId:second.id,provider:'codex-sdk',status:'running',elapsedMs:0,steps:0,trace:[]};
  await executeWorkflow(outcome,task.goal,workflowSchema.parse({values:task.values,derivedValues:task.derivedValues,attachments:task.attachments,success:task.success,nativeInput:true}),false,8,async(command,payload)=>{
    if(command==='select'){const choices=payload.request.choices;const choice=choices.find(choice=>choice.description.startsWith('Set Customer'))??choices.find(choice=>choice.id==='upload_0')??choices.find(choice=>choice.description.startsWith('Activate button: Save'));assert(choice,JSON.stringify({choices,targets:payload.request.context.page.targets.map(({name,kind,value})=>({name,kind,value}))}));return {status:'selected',choiceId:choice.id,model:'integration_fixture',latencyMs:0};}
    const names={'v2.frames':'browser_frames','v2.state':'browser_state','v2.read':'browser_read','v2.plan':'browser_plan','v2.commit':'browser_commit','workflow.download':'browser_download','workflow.document':'browser_document_read','workflow.upload':'browser_upload'};assert(names[command],command);return tool(names[command],{sessionId:second.id,...payload});
  },value=>value);
  assert.equal(outcome.status,'completed');await tool('browser_session_release',{sessionId:second.id});
  const promptSession=await tool('browser_session_create',{profileId,name:'Human native prompt',allowedOrigins:[info.public_url]});let humanDialog;
  context.on('dialog',dialog=>{humanDialog=dialog;});
  await tool('browser_session_open',{sessionId:promptSession.id,url:info.public_url+'/task/BCB-C23-V03',active:true,waitForReady:true});
  const promptFlow=workflowSchema.parse({success:{name:'Receipt',contains:'Saved'},nativeInput:true});const promptStatus={id:'prompt',sessionId:promptSession.id,provider:'codex-sdk',status:'running',elapsedMs:0,steps:0,trace:[]};let saves=0;
  const promptDispatch=async(command,payload)=>{
    if(command==='select'){const choice=payload.request.choices.find(choice=>choice.description.startsWith('Activate button: Save'));assert(choice);saves++;return {status:'selected',choiceId:choice.id,model:'integration_fixture',latencyMs:0};}
    const names={'v2.frames':'browser_frames','v2.state':'browser_state','v2.read':'browser_read','v2.plan':'browser_plan','v2.commit':'browser_commit','v2.handoff':'browser_handoff'};assert(names[command],command);return tool(names[command],{sessionId:promptSession.id,...payload});
  };
  const promptStarted=performance.now();await executeWorkflow(promptStatus,'Start Save and let the human answer the prompt',promptFlow,false,5,promptDispatch,value=>value);
  assert(performance.now()-promptStarted<15000,'Human dialog must not block the workflow until its overall timeout');assert.equal(promptStatus.status,'needs_input');assert.equal(promptStatus.code,'needs_user');assert.equal(humanDialog.type(),'prompt');assert.equal(humanDialog.message(),'Human confirmation');assert.equal(saves,1);
  const stopped=tool('browser_cancel',{sessionId:promptSession.id});
  const stopReady=await Promise.race([stopped.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),2500))]);
  if(!stopReady){await humanDialog.accept('approved');await stopped;throw Error('Cancel waited for human dialog input');}
  assert.equal(humanDialog.type(),'prompt','Cancel must leave the human dialog open');
  // Only the isolated operator simulates human input; the executor leaves it open.
  await humanDialog.accept('approved');await tool('browser_resume',{sessionId:promptSession.id});const resumedPrompt={...promptStatus,status:'running',trace:[],steps:0};
  await executeWorkflow(resumedPrompt,'Verify the saved receipt',promptFlow,false,3,promptDispatch,value=>value);assert.equal(resumedPrompt.status,'completed');assert.equal(saves,1,'No repeated save after the human returns control');
  const promptOracle=JSON.parse(await readFile(path.join(judge,'world-oracle.json'),'utf8')).cases['BCB-C23-V03'];assert.equal(promptOracle.events.length,1);assert.deepEqual(promptOracle.events[0].data,promptOracle.expected);await tool('browser_session_release',{sessionId:promptSession.id});
  const releaseSession=await tool('browser_session_create',{profileId,name:'Release with human prompt',allowedOrigins:[info.public_url]});humanDialog=undefined;
  await tool('browser_session_open',{sessionId:releaseSession.id,url:info.public_url+'/task/BCB-C23-V03',active:true,waitForReady:true});const releaseState=await tool('browser_state',{sessionId:releaseSession.id});
  const releasePlan=await tool('browser_plan',{sessionId:releaseSession.id,stateVersion:releaseState.stateVersion,action:{type:'click',targetId:releaseState.snapshot.targets.find(target=>target.kind==='button'&&target.name==='Save').id,backend:'native'}});
  const releaseCommit=await tool('browser_commit',{sessionId:releaseSession.id,actionId:releasePlan.actionId,stateVersion:releasePlan.stateVersion});assert.equal(releaseCommit.readiness.state,'needs_user');
  const released=tool('browser_session_release',{sessionId:releaseSession.id});const releaseReady=await Promise.race([released.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),2500))]);
  if(!releaseReady){await humanDialog.dismiss();await released;throw Error('Release waited for human dialog input');}assert.equal(humanDialog.type(),'prompt');await humanDialog.dismiss();
  assert.equal(JSON.parse(await readFile(path.join(judge,'world-oracle.json'),'utf8')).cases['BCB-C23-V03'].events.length,1);
  console.log(JSON.stringify({passed:true,checks:['local PDF source','trusted exact field insertion','one owned artifact upload','one server save','controller PDF pipeline with independently supplied choice IDs','native prompt stops for a human','fresh prompt resume verifies without replay','cancel and release complete while human prompt stays open']}));
}finally{clearTimeout(timeout);await client?.close().catch(()=>{});await context?.close();server.kill();}
