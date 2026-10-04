// Delivery only: original public goal, no expected answer, selectors or workflow hints.
import path from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const profileId=process.argv[2],root=path.resolve(import.meta.dirname,'..');
let raw='';for await(const part of process.stdin){raw+=part;if(raw.length>50000)throw Error('packet_limit');}
const packet=JSON.parse(raw),url=new URL(packet.start_url),started=performance.now();
if(!profileId||url.protocol!=='http:'||!['localhost','127.0.0.1'].includes(url.hostname)||!Number.isInteger(packet.task_id)||typeof packet.intent!=='string'||packet.intent.length>1500)throw Error('invalid_public_packet');
const client=new Client({name:'webarena-installed-delivery',version:'1'});let sessionId,result,stage="connect";
const call=async(name,args={})=>{const response=await client.callTool({name,arguments:args});const value=JSON.parse(response.content.find(c=>c.type==='text').text);if(response.isError)throw Object.assign(Error(value.code),{code:value.code});return value;};
try{
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/host/mcp.js')],stderr:'ignore'}));
  stage='profile';const profile=(await call('browser_profiles')).find(p=>p.id===profileId);
  if(!profile||profile.mode!=='safe'||!['codex-sdk','typesafe-jev'].includes(profile.activeProvider))throw Error('profile_configuration_changed');
  stage='session_create';const session=await call('browser_session_create',{profileId,name:`WebArena ${packet.task_id}`,allowedOrigins:[url.origin]});sessionId=session.id;
  stage='session_open';const opened=await call('browser_session_open',{sessionId,url:url.href,active:true,waitForReady:true});if(!opened.attached)throw Error('attach_failed');
  stage='run_start';const run=await call('browser_run_start',{sessionId,goal:packet.intent,task:true,maxSteps:30,timeoutMs:Math.floor(Math.max(1000,Math.min(285000,300000-(performance.now()-started)-15000)))});
  stage='run_status';let outcome;
  do{await new Promise(r=>setTimeout(r,100));outcome=await call('browser_run_status',{runId:run.id});}while(outcome.status==='running');
  stage='response';const answer=outcome.answer;
  const value=typeof answer==='string'&&/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(answer)?Number(answer):answer;
  result={task_id:packet.task_id,controller_status:outcome.status,code:outcome.code,
    agent_response:{task_type:'RETRIEVE',status:outcome.status==='completed'?'SUCCESS':'UNKNOWN_ERROR',retrieved_data:outcome.status==='completed'?(outcome.answerValues??[value]):null,error_details:outcome.status==='completed'?null:outcome.code??'controller_failed'},
    actual_provider:profile.activeProvider,actual_model:outcome.trace.at(-1)?.model??null,
    metrics:{steps:outcome.steps,controller_ms:outcome.elapsedMs,provider_ms:outcome.trace.reduce((sum,t)=>sum+(t.providerMs??0),0)}};
}catch(error){result={task_id:packet.task_id,controller_status:'failed',stage,code:/^[a-z_]+$/.test(error.code??error.message??'')?(error.code??error.message):'adapter_failed',agent_response:{task_type:'RETRIEVE',status:'UNKNOWN_ERROR',retrieved_data:null,error_details:'adapter_failed'}};}
finally{
  if(sessionId)await call('browser_session_release',{sessionId,closeCreatedTabs:true}).then(cleanup=>{if(result)result.cleanup=cleanup;}).catch(()=>{if(result)result.cleanup_failed=true;});
  await client.close().catch(()=>{});
}
console.log(JSON.stringify(result));
