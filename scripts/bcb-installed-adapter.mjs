// Existing-profile delivery adapter; no permission, preference, vault or fixture changes.
import path from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const root=path.resolve(import.meta.dirname,'..'),profileId=process.argv[2],visualProvider=process.argv[3];
let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>50000)throw Error('packet_limit');}
const packet=JSON.parse(input),started=performance.now();
if(!profileId||!packet.allowed_origins.every(value=>{const url=new URL(value);return url.protocol==='http:'&&url.hostname==='127.0.0.1';}))throw Error('isolated_fixture_required');
if(visualProvider&&!['codex-sdk','claude-sdk'].includes(visualProvider))throw Error('invalid_visual_provider');
const client=new Client({name:'bcb-installed-chrome',version:'2'});let sessionId,result;
const tool=async(name,args={})=>{const response=await client.callTool({name,arguments:args});const value=JSON.parse(response.content.find(item=>item.type==='text').text);if(response.isError)throw Object.assign(Error(value.code),{code:value.code});return value;};
try{
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/host/mcp.js')],env:{...process.env,TABORA_FILE_ROOTS:JSON.stringify([packet.workspace])},stderr:'ignore'}));
  const profile=(await tool('browser_profiles')).find(item=>item.id===profileId);
  if(!profile||profile.mode!=='safe'||!['typesafe-jev','codex-sdk','claude-sdk'].includes(profile.activeProvider))throw Object.assign(Error('profile_configuration_changed'),{code:'profile_configuration_changed'});
  const session=await tool('browser_session_create',{profileId,name:'BCB timed '+packet.task.id,allowedOrigins:packet.allowed_origins});sessionId=session.id;
  const capability=await tool('browser_capabilities',{sessionId});
  if(capability.capabilities.nativeInput.status!=='available')throw Object.assign(Error('native_input_permission_required'),{code:'native_input_permission_required'});
  const visual=packet.task.modality==='vision'||packet.task.execution_lane==='vision';
  if(visual&&capability.capabilities.capture.status!=='available')throw Object.assign(Error('capture_permission_required'),{code:'capture_permission_required'});
  const opened=await tool('browser_session_open',{sessionId,url:packet.url,active:true,waitForReady:true});if(!opened.attached)throw Object.assign(Error(opened.code),{code:opened.code});
  const task=packet.task,setupMs=Math.round(performance.now()-started),attachments=(task.attachments??[]).map(source=>source.document?source:{field:source.field,files:source.filenames.map(name=>({name}))});
  const run=await tool('browser_run_start',{sessionId,goal:task.goal,maxSteps:30,timeoutMs:Math.min(300000,Math.floor(packet.deadline_seconds*1000)-5000),workflow:{values:task.values??[],edits:task.edits??[],attachments,reads:task.reads??[],documents:task.documents??[],derivedValues:task.derivedValues??[],answer:task.answer,failure:task.failure,prerequisites:task.prerequisites??[],success:task.answer?undefined:task.success??{name:'Receipt',contains:'Saved'},visual:visual?{provider:visualProvider}:undefined}});
  let outcome;do{await new Promise(resolve=>setTimeout(resolve,50));outcome=await tool('browser_run_status',{runId:run.id});}while(outcome.status==='running');
  const actualProviders=[...new Set(outcome.trace.map(item=>item.provider??profile.activeProvider))];
  result={status:outcome.status==='completed'?'completed':outcome.status==='needs_input'?'needs_user':'failed',code:outcome.code,answer:outcome.answer,actual_provider:actualProviders.join('+')||'local-reader',actual_model:outcome.trace.at(-1)?.model??'none',metrics:{task_wall_ms:Math.round(performance.now()-started),setup_ms:setupMs,controller_ms:outcome.elapsedMs,steps:outcome.steps,provider_ms:outcome.trace.reduce((sum,item)=>sum+(item.providerMs??0),0),visual_observation_ms:outcome.trace.reduce((sum,item)=>sum+(item.observationMs??0),0),operation_ms:outcome.trace.reduce((sum,item)=>sum+(item.operationMs??0),0),temperature:'existing_profile',native_input:true,profile_name:profile.name,task_tab_id:opened.tabId,modality:visual?'vision':'text',configured_text_provider:profile.activeProvider,configured_visual_provider:visualProvider??profile.activeProvider,evidence:outcome.evidence,trace:outcome.trace.map(({step,choiceId,provider,model,modality,targetKind,targetName,code,stage})=>({step,choiceId,provider,model,modality,targetKind,targetName,code,stage})),timing_scope:'public packet received through verified website outcome; outer coordinator adds process startup/cleanup; no operator intervention'}};
}catch(error){result={status:'failed',code:typeof error.code==='string'&&/^[a-z_]+$/.test(error.code)?error.code:'adapter_failed',metrics:{task_wall_ms:Math.round(performance.now()-started)}};}
finally{const cleanup=performance.now();if(sessionId)await client.callTool({name:'browser_session_release',arguments:{sessionId,closeCreatedTabs:true}}).then(response=>{if(result?.metrics){result.metrics.cleanup_failed=!!response.isError;result.metrics.cleanup_result=JSON.parse(response.content.find(item=>item.type==='text').text);}}).catch(()=>{if(result?.metrics)result.metrics.cleanup_failed=true;});await client.close().catch(()=>{});if(result?.metrics)result.metrics.cleanup_ms=Math.round(performance.now()-cleanup);}
console.log(JSON.stringify(result));
