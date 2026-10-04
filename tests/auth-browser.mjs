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
const server=spawn('python',['-X','utf8',path.resolve('../browser-capability-bench/suite.py'),'serve','--judge-dir',judge,'--workspace',path.join(directory,'workspace'),'--seed','101','--tls'],{windowsHide:true,stdio:['ignore','pipe','ignore']});
const info=await new Promise((resolve,reject)=>{let output='';const timeout=setTimeout(()=>reject(Error('fixture_startup_timeout')),15000);server.stdout.on('data',data=>{output+=data;const end=output.indexOf('\n');if(end>=0){clearTimeout(timeout);resolve(JSON.parse(output.slice(0,end)));}});server.once('error',reject);});
await cp('dist/extension',extension,{recursive:true});const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));manifest.host_permissions=['https://127.0.0.1/*'];await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
let context,client;const timeout=setTimeout(()=>{console.error('Workflow integration timeout');process.exit(1);},120000);
try{
  context=await chromium.launchPersistentContext(path.join(directory,'chromium'),{channel:'chromium',headless:true,ignoreHTTPSErrors:true,args:['--ignore-certificate-errors',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],env:{...process.env,TABORA_STATE_DIR:state}});
  const panel=await context.newPage(),extensionId=(await readFile('extension-id.txt','utf8')).trim();await panel.goto(`chrome-extension://${extensionId}/panel.html`);await panel.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Lokální host připojený');
  const rpc=async(command,payload)=>{const reply=await panel.evaluate(message=>chrome.runtime.sendMessage(message),{command,payload});assert(reply.ok,reply.code);return reply.data;};
  const profileId=(await rpc('status')).profile.id;await rpc('profile.update',{vaultEnabled:true});await rpc('vault.unlock');
  const synthetic=JSON.parse(await readFile(path.join(judge,'synthetic-auth.json'),'utf8'));
  const vault=await rpc('vault.put',{kind:'website',label:'Synthetic fixture only',origin:info.public_url,username:synthetic.username,secret:synthetic.password,scope:{type:'profile',profileId}});const credentialId=vault.entries.find(entry=>entry.label==='Synthetic fixture only').id;
  client=new Client({name:'assisted-auth-integration',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/host/mcp.js')],env:{...process.env,TABORA_STATE_DIR:state},stderr:'ignore'}));
  async function tool(name,args={},errorCode){const reply=await client.callTool({name,arguments:args}),value=JSON.parse(reply.content.find(part=>part.type==='text').text);if(errorCode){assert(reply.isError);assert.equal(value.code,errorCode);}else assert(!reply.isError,JSON.stringify(value));return value;}
  const session=await tool('browser_session_create',{profileId,name:'Synthetic HTTPS login and human MFA',allowedOrigins:[info.public_url]});const sessionId=session.id;
  await tool('browser_session_open',{sessionId,url:info.public_url+'/task/W09',active:true,waitForReady:true});
  const flow=workflowSchema.parse({logins:[{credentialId,origin:info.public_url}],success:{name:'Receipt',contains:'Saved'},nativeInput:true});
  const status={id:'synthetic-auth',sessionId,provider:'typesafe-jev',status:'running',elapsedMs:0,steps:0,trace:[]};
  let lastState;
  const dispatch=async(command,payload={})=>{
    if(command==='vault.list')return tool('browser_vault_list',{profileId});
    if(command==='v2.credential'){const result=await tool('browser_credential_fill',{sessionId,...payload});const page=context.pages().find(page=>page.url()===info.public_url+'/task/W09');assert.equal(await page.locator('[name=username]').inputValue(),synthetic.username);assert.equal(await page.locator('[name=password]').inputValue(),synthetic.password);return result;}
    const mapping={'v2.frames':'browser_frames','v2.state':'browser_state','v2.read':'browser_read','v2.plan':'browser_plan','v2.commit':'browser_commit','v2.handoff':'browser_handoff',observe:'browser_observe',manual:'browser_prepare',step:'browser_step'};
    if(command==='select'){assert(!JSON.stringify(payload).includes(synthetic.password));const choices=payload.request.choices,choice=choices.find(choice=>choice.id.startsWith('login_'))??choices.find(choice=>choice.description.startsWith('Activate button: Sign in'))??choices.find(choice=>choice.description.startsWith('Activate button: Save'));assert(choice,JSON.stringify(choices));return {status:'selected',choiceId:choice.id,model:'integration-choice',latencyMs:0};}
    const result=await tool(mapping[command],{sessionId,...payload});if(command==='v2.state')lastState=result;if(command==='step'){const page=context.pages().find(page=>page.url()===info.public_url+'/task/W09');assert((await page.locator('[name=username]').inputValue())===synthetic.username,'Username channel');assert((await page.locator('[name=password]').inputValue())===synthetic.password,'Password channel');}return result;
  };
  await executeWorkflow(status,'Sign in and save',flow,false,8,dispatch,value=>value);assert.equal(status.status,'needs_input');assert.equal(status.code,'mfa_required');assert(!JSON.stringify(status).includes(synthetic.password));
  const page=context.pages().find(page=>page.url()===info.public_url+'/task/W09');await page.waitForSelector('[aria-label=MFA]');const held=lastState;const verify=held.snapshot.targets.find(target=>target.name==='Verify MFA'&&target.kind==='button');await tool('browser_plan',{sessionId,stateVersion:held.stateVersion,action:{type:'click',targetId:verify.id}},'needs_user');const beforeMfa=held.snapshot.provenance.documentToken;
  // The harness simulates the explicitly assisted human lane. The agent never receives the code.
  await page.locator('[name=code]').fill(synthetic.mfa);await page.getByRole('button',{name:'Verify MFA'}).click();await page.waitForSelector('button:text-is("Save")');
  const resumed=await tool('browser_resume',{sessionId});assert.notEqual(resumed.snapshot.provenance.documentToken,beforeMfa);assert.deepEqual(resumed.humanProgress,{status:'control_returned',reason:'mfa'});const resumedStatus={...status,id:'resumed-auth',status:'running',steps:0,trace:[]};await executeWorkflow(resumedStatus,'Save once',flow,false,5,dispatch,value=>value);assert.equal(resumedStatus.status,'completed');await page.waitForFunction(()=>document.querySelector('[aria-label=Receipt]')?.textContent==='Saved');
  const oracle=JSON.parse(await readFile(path.join(judge,'world-oracle.json'),'utf8')).cases.W09;assert.deepEqual(oracle.authentication_events,[{operation:'login',accepted:true},{operation:'human_mfa',accepted:true},{operation:'save',accepted:true}]);assert.equal(oracle.events.length,1);
  await tool('browser_session_release',{sessionId});await rpc('vault.lock');
  console.log(JSON.stringify({passed:true,lane:'assisted_executor',checks:['real HTTPS/password validation','opaque scoped credential channel','no password in observations','MFA handoff blocks agent input','simulated human MFA','fresh resume','one independently authorized server save']}));
}finally{clearTimeout(timeout);await client?.close().catch(()=>{});await context?.close();server.kill();}
