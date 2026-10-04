// Public-goal delivery and terminal observation only; no expected answers.
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const profileId=process.argv[2],root=path.resolve(import.meta.dirname,'..');
const client=new Client({name:'internet-compatibility-pilot',version:'1'});
const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});const value=JSON.parse(r.content.find(c=>c.type==='text').text);if(r.isError)throw Object.assign(Error(value.code),{code:value.code});return value;};
let sessionId,terminalSent=false,stage='connect';
const emit=value=>console.log(JSON.stringify(value));
try{
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/host/mcp.js')],env:process.env,stderr:'ignore'}));
  const profile=(await call('browser_profiles')).find(p=>p.id===profileId);
  if(!profile||profile.mode!=='safe'||!['codex-sdk','typesafe-jev'].includes(profile.activeProvider))throw Error('profile_configuration_changed');
  emit({event:'ready'});
  let raw='';for await(const part of process.stdin){raw+=part;if(raw.length>50000)throw Error('packet_limit');}
  const packet=JSON.parse(raw),url=new URL(packet.url),started=performance.now();
  if(url.origin!=='https://the-internet.herokuapp.com'||typeof packet.goal!=='string'||packet.goal.length>1500)throw Error('invalid_public_packet');
  stage='session_create';const session=await call('browser_session_create',{profileId,name:'Online test '+packet.id,allowedOrigins:[url.origin]});sessionId=session.id;
  stage='session_open';const opened=await call('browser_session_open',{sessionId,url:url.href,active:true,waitForReady:true,readinessTimeoutMs:Math.min(45000,Math.max(1000,Math.floor(105000-(performance.now()-started))))});if(!opened.attached)throw Error(opened.code??'attach_failed');
  const capabilities=await call('browser_capabilities',{sessionId});const expectedBuild=JSON.parse(await readFile(path.join(root,'dist/build-info.json'),'utf8'));if(!capabilities.build?.sameBuild||capabilities.build.host.fingerprint!==expectedBuild.fingerprint)throw Error('installed_build_mismatch');emit({event:'build',build:capabilities.build});
  stage='run_start';const run=await call('browser_run_start',{sessionId,goal:packet.goal,task:true,maxSteps:30,timeoutMs:Math.max(1000,Math.floor(105000-(performance.now()-started)))});
  stage='run_status';let outcome;
  do{await new Promise(r=>setTimeout(r,100));outcome=await call('browser_run_status',{runId:run.id});}while(outcome.status==='running');
  if(outcome.execution?.engine!=='workflow-v2'||outcome.execution?.contractVersion!==2)throw Error('unexpected_execution_engine');
  emit({event:'terminal',execution:outcome.execution,metrics:outcome.metrics,status:outcome.status,code:outcome.code,answer:outcome.answer,answerValues:outcome.answerValues,actual_provider:profile.activeProvider,actual_model:outcome.trace.at(-1)?.model,steps:outcome.steps,trace:outcome.trace});terminalSent=true;
  stage='observer';const evidence={};
  try{evidence.state=await call('browser_state',{sessionId,fresh:true,limit:100});evidence.snapshot=await call('browser_observe',{sessionId,recipe:'all'});}catch(error){evidence.error=error.code??'observation_failed';}
  emit({event:'evidence',evidence});
}catch(error){if(!terminalSent)emit({event:'terminal',status:'failed',stage,code:/^[a-z_]+$/.test(error.code??error.message??'')?(error.code??error.message):'adapter_failed'});}
finally{
  const started=performance.now();let cleanup;
  if(sessionId)cleanup=await call('browser_session_release',{sessionId,closeCreatedTabs:true}).catch(()=>({failed:true}));
  await client.close().catch(()=>{});emit({event:'cleanup',cleanup_ms:Math.round(performance.now()-started),result:cleanup});
}
