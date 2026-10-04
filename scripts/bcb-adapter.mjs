// Participant-specific delivery adapter. All browser actions go through real extension MCP.
import {readFile,mkdir,mkdtemp,cp,writeFile,readdir,rm} from 'node:fs/promises';import path from 'node:path';
import {Client} from '@modelcontextprotocol/client';import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {createHash} from 'node:crypto';
import {originPermission} from './setup-lib.mjs';
const root=path.resolve(import.meta.dirname,'..');
const provider=process.argv[2],requestedModel=process.argv[3];
const visualProvider=process.argv[4],visualModel=process.argv[5];
if(!['codex-sdk','claude-sdk','typesafe-jev'].includes(provider))throw Error('A supported provider argument is required');
if(visualProvider&&!['codex-sdk','claude-sdk'].includes(visualProvider))throw Error('A supported image provider is required');
let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>50000)throw Error('Oversized task');}
// Chromium's Windows native-host launch can fail with deeply nested user-data paths.
// Keep disposable browser state separate from the task's approved file workspace.
const packet=JSON.parse(input),stateBase=path.join(root,'.test-state');await mkdir(stateBase,{recursive:true});const state=await mkdtemp(path.join(stateBase,'bcb-'));
const env={...process.env,TABORA_STATE_DIR:state,TABORA_FILE_ROOTS:JSON.stringify([packet.workspace])};
async function bundleHash(){const hash=createHash('sha256');async function visit(directory){for(const file of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const filename=path.join(directory,file.name);if(file.isDirectory())await visit(filename);else if(file.isFile())hash.update(path.relative(root,filename)).update('\0').update(await readFile(filename));}}await visit(path.join(root,'dist'));hash.update(await readFile(import.meta.filename));return hash.digest('hex');}
const sourceHash=await bundleHash(),setupStarted=performance.now();let setupMs=0,browserVersion;
let client,sessionId,result,context,connectedBrowser,setupStage='browser';
try{
  const existing=packet.existing_browser;
  if(existing){const url=new URL(existing.endpoint);if(existing.isolation!=='operator_owned_temporary_profile'||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||existing.page_url!==packet.url)throw Error('Existing isolated browser binding is invalid');}
  const extension=path.join(state,'extension');await cp(path.join(root,'dist/extension'),extension,{recursive:true});
  const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));manifest.host_permissions=[...new Set(packet.allowed_origins.map(origin=>originPermission(origin).pattern))];await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
  // Configuration is a panel-owned setup operation, never a second browser executor.
  const {chromium}=await import('playwright');if(existing){connectedBrowser=await chromium.connectOverCDP(existing.endpoint);context=connectedBrowser.contexts()[0];browserVersion=connectedBrowser.version();}else{context=await chromium.launchPersistentContext(path.join(state,'chromium'),{...(packet.runtime?.browser_executable?{executablePath:packet.runtime.browser_executable}:{channel:'chromium'}),viewport:packet.runtime?.viewport??{width:1280,height:720},headless:true,ignoreHTTPSErrors:!!packet.fixture_tls?.self_signed,args:[...(packet.observer_setup?.channel_directory?['--remote-debugging-port=0']:[]),...(packet.fixture_tls?.self_signed?['--ignore-certificate-errors']:[]),...(packet.task.site_tools?['--enable-blink-features=WebMCP']:[]),`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],env});browserVersion=context.browser()?.version();}context.on('dialog',()=>{});
  const extensionId=(await readFile(path.join(root,'extension-id.txt'),'utf8')).trim(),panel=await context.newPage();await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  setupStage='native_connection';
  await panel.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Lokální host připojený');
  const rpc=async(command,payload)=>{const reply=await panel.evaluate(message=>chrome.runtime.sendMessage(message),{command,payload});if(!reply.ok)throw Object.assign(Error(reply.code),{code:reply.code});return reply.data;};
  setupStage='provider_configuration';
  const catalog=await rpc('provider.catalog',{provider,connection:provider==='typesafe-jev'?'environment':'sdk'});
  const model=requestedModel??catalog.models.find(model=>model.isDefault)?.id??catalog.models[0]?.id;if(!model)throw Object.assign(Error('missing_model'),{code:'missing_model'});
  await rpc('configure',{provider,model,connection:provider==='typesafe-jev'?'environment':'sdk',timeoutMs:60000});
  if(visualProvider&&visualProvider!==provider){if(!visualModel)throw Object.assign(Error('missing_visual_model'),{code:'missing_visual_model'});await rpc('configure',{provider:visualProvider,model:visualModel,connection:'sdk',timeoutMs:60000});}
  await rpc('profile.update',{activeProvider:provider,mode:existing?'takeover':packet.task.mode??'safe'});const status=await rpc('status');await panel.close();
  setupStage='mcp_connection';
  client=new Client({name:'bcb-tabora-participant',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/host/mcp.js')],env,stderr:'ignore'}));
  const tool=async(name,args={})=>{const reply=await client.callTool({name,arguments:args}),value=JSON.parse(reply.content.find(part=>part.type==='text').text);if(reply.isError)throw Object.assign(Error(value.code),{code:value.code});return value;};
  setupStage='session_setup';
  const session=await tool('browser_session_create',{profileId:status.profile.id,name:packet.task.goal.slice(0,80),allowedOrigins:packet.allowed_origins,allowPopups:!!packet.task.followPopups,siteTools:!!packet.task.site_tools});sessionId=session.id;
  let opened;if(existing){const tabs=await tool('browser_tabs',{profileId:status.profile.id});const matched=tabs.filter(tab=>tab.url===packet.url);if(matched.length!==1)throw Error('Existing task tab is ambiguous');opened=await tool('browser_session_attach',{sessionId,tabId:matched[0].id});}else{opened=await tool('browser_session_open',{sessionId,url:packet.url,active:true,waitForReady:true});if(!opened.attached)throw Object.assign(Error(opened.code),{code:opened.code});}
  if(packet.observer_setup?.channel_directory){
    const channel=path.resolve(packet.observer_setup.channel_directory);if(channel!==path.resolve(packet.workspace,'.observer-channel'))throw Object.assign(Error('observer_channel_invalid'),{code:'observer_channel_invalid'});
    const [port]= (await readFile(path.join(state,'chromium','DevToolsActivePort'),'utf8')).split('\n');if(!/^\d+$/.test(port))throw Error('Invalid browser probe port');
    await writeFile(path.join(channel,'endpoint.json'),JSON.stringify({state_directory:state,browser_url:'http://127.0.0.1:'+port,profile_id:status.profile.id,session_id:sessionId,tab_id:opened.tabId}));
    const deadline=performance.now()+30000;let released=false;
    while(performance.now()<deadline){try{const ready=JSON.parse(await readFile(path.join(channel,'ready.json'),'utf8'));if(ready.episode_id===packet.episode_id){released=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,25));}
    if(released)await tool('browser_session_attach',{sessionId,tabId:opened.tabId});
    if(!released)throw Object.assign(Error('observer_setup_failed'),{code:'observer_setup_failed'});
  }
  const attachments=(packet.task.attachments??[]).map(source=>source.document?source:{field:source.field,files:source.filenames.map(name=>({name}))});
  setupMs=Math.round(performance.now()-setupStarted);
  let logins=[];if(packet.observer_setup?.channel_directory){try{logins=JSON.parse(await readFile(path.join(packet.observer_setup.channel_directory,'credentials.json'),'utf8')).logins;}catch{}}
  const visual=packet.task.modality==='vision'||packet.task.execution_lane==='vision';
  const startRun=()=>tool('browser_run_start',{sessionId,goal:packet.task.goal,provider,maxSteps:30,timeoutMs:Math.min(300000,Math.floor(packet.deadline_seconds*1000)-5000),workflow:{logins,values:packet.task.values??[],edits:packet.task.edits??[],attachments,documents:packet.task.documents??[],derivedValues:packet.task.derivedValues??[],reads:packet.task.reads??[],drags:packet.task.drags??[],downloads:packet.task.downloads??[],dialogs:packet.task.dialogs??[],answer:packet.task.answer,finish:packet.task.finish,failure:packet.task.failure,prerequisites:packet.task.prerequisites??[],followPopups:!!packet.task.followPopups,siteOperations:packet.task.siteOperations??[],success:packet.task.answer||packet.task.finish?undefined:packet.task.success??{name:'Receipt',contains:'Saved'},visual:visual?{provider:visualProvider??provider}:undefined}});
  setupStage='workflow';
  const outcomes=[];let run=await startRun(),outcome;
  for(let phase=0;phase<2;phase++){
    do{await new Promise(resolve=>setTimeout(resolve,100));outcome=await tool('browser_run_status',{runId:run.id});}while(outcome.status==='running');outcomes.push(outcome);
    const assistedHandoff=outcome.code==='mfa_required'||outcome.code==='needs_user'&&packet.task.supervisor?.type==='prompt';
    if(outcome.status!=='needs_input'||!assistedHandoff||!packet.observer_setup?.channel_directory||phase>0)break;
    const channel=packet.observer_setup.channel_directory;await writeFile(path.join(channel,'handoff.json'),JSON.stringify({episode_id:packet.episode_id,code:outcome.code}));
    const deadline=performance.now()+Math.min(30000,packet.deadline_seconds*1000);let resumed=false;
    while(performance.now()<deadline){try{const signal=JSON.parse(await readFile(path.join(channel,'resume.json'),'utf8'));if(signal.episode_id===packet.episode_id){resumed=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,25));}
    if(!resumed)break;await tool('browser_resume',{sessionId});run=await startRun();
  }
  outcome={...outcome,trace:outcomes.flatMap(outcome=>outcome.trace),elapsedMs:outcomes.reduce((total,outcome)=>total+outcome.elapsedMs,0),steps:outcomes.reduce((total,outcome)=>total+outcome.steps,0)};

  const artifacts=[];for(const artifact of outcome.artifacts??[]){const chunks=[];let offset=0;for(;;){const chunk=await tool('browser_artifact_chunk',{sessionId,artifactId:artifact.id,offset});chunks.push(Buffer.from(chunk.data,'base64'));if(chunk.eof)break;if(chunk.nextOffset<=offset)throw Object.assign(Error('file_transfer_incomplete'),{code:'file_transfer_incomplete'});offset=chunk.nextOffset;}const filename=path.join(packet.workspace,artifact.name);await writeFile(filename,Buffer.concat(chunks),{flag:'wx'});artifacts.push(filename);chunks.forEach(chunk=>chunk.fill(0));}
  result={status:outcome.status==='completed'?'completed':outcome.status==='needs_input'?'needs_user':'failed',code:outcome.code,answer:outcome.answer,artifacts,actual_provider:[...new Set(outcome.trace.map(step=>step.provider??provider))].join('+')||'local-reader',actual_model:outcome.trace.at(-1)?.model??'none',metrics:{source_hash:sourceHash,browser_version:browserVersion,setup_ms:setupMs,lane:outcomes.length>1?'assisted_human':'automated',temperature:packet.existing_browser?'upstream_existing_profile':'cold_isolated_episode',configured_provider:provider,configured_model:model,controller_ms:outcome.elapsedMs,steps:outcome.steps,provider_ms:outcome.trace.reduce((total,step)=>total+(step.providerMs??0),0),operation_ms:outcome.trace.reduce((total,step)=>total+(step.operationMs??0),0),visual_observation_ms:outcome.trace.reduce((total,step)=>total+(step.observationMs??0),0),configured_visual_provider:visualProvider??provider,modality:visual?'vision':'text',viewport:packet.runtime?.viewport??{width:1280,height:720},evidence:outcome.evidence,trace:outcome.trace.map(({step,choiceId,provider,model,modality,targetKind,targetName,code,stage})=>({step,choiceId,provider,model,modality,targetKind,targetName,code,stage}))}};
}catch(error){result={status:'failed',code:typeof error.code==='string'&&/^[a-z_]+$/.test(error.code)?error.code:'adapter_failed',metrics:{setup_stage:setupStage,error_type:error.name==='TimeoutError'?'timeout':'adapter_error'}};}
finally{
  const cleanupStarted=performance.now(),cleanup={};
  if(sessionId&&client)await client.callTool({name:'browser_session_release',arguments:{sessionId}}).catch(()=>{});
  cleanup.release_ms=Math.round(performance.now()-cleanupStarted);
  let stage=performance.now();await client?.close().catch(()=>{});cleanup.mcp_close_ms=Math.round(performance.now()-stage);
  stage=performance.now();if(connectedBrowser)await connectedBrowser.close().catch(()=>{});else await context?.close().catch(()=>{});cleanup.browser_close_ms=Math.round(performance.now()-stage);
  if(!connectedBrowser){if(path.dirname(state)!==stateBase)throw Error('Unsafe temporary state directory');await rm(state,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
  if(result?.metrics)result.metrics.cleanup=cleanup;
}
if(sourceHash!==await bundleHash())result={status:'failed',code:'participant_changed_during_episode'};
console.log(JSON.stringify(result));
