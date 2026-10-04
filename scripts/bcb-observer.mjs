// An operator-owned process probes the real API. It never accepts candidate metrics as proof.
import {extraProbe,probeKinds} from './bcb-probes.mjs';
import {createInterface} from 'node:readline';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {chromium} from 'playwright';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const lines=createInterface({input:process.stdin,crlfDelay:Infinity})[Symbol.asyncIterator]();
const receive=async()=>JSON.parse((await lines.next()).value),send=value=>console.log(JSON.stringify(value));
const start=await receive(),packet=start.packet,kind=packet.task.probe_contract?.kind;
const supported=[...probeKinds,'rpc_validation','connection_ownership','missing_delta_baseline','worker_generation','native_site_discovery','typed_site_call','untrusted_site_schema','synthetic_auth_mfa','human_dialog'].includes(kind);
const directory=path.join(packet.workspace,'.observer-channel');await mkdir(directory,{recursive:true});
send({phase:'ready',episode_id:packet.episode_id,supported,participant_setup:supported?{channel_directory:directory}:{}});
let browser,client,other,sessionId,authSetup;const transcript=[];let assertions=[];
const root=path.resolve(import.meta.dirname,'..');
try{
  const next=await receive();
  if(next.phase==='participant_started'&&supported){
    const deadline=performance.now()+30000;let endpoint;
    while(performance.now()<deadline){try{endpoint=JSON.parse(await readFile(path.join(directory,'endpoint.json'),'utf8'));break;}catch{await new Promise(resolve=>setTimeout(resolve,25));}}
    if(!endpoint||endpoint.state_directory!==path.join(packet.workspace,'.tabora'))throw Error('Invalid independent channel binding');
    const url=new URL(endpoint.browser_url);if(url.hostname!=='127.0.0.1'||url.protocol!=='http:'||!url.port)throw Error('Invalid isolated browser endpoint');
    browser=await chromium.connectOverCDP(url.href);const context=browser.contexts()[0];let humanDialog;
    if(kind==='human_dialog')context.on('dialog',dialog=>{humanDialog=dialog;});
    const connect=async()=>{const c=new Client({name:'bcb-independent-observer',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/host/mcp.js')],env:{...process.env,TABORA_STATE_DIR:endpoint.state_directory,TABORA_FILE_ROOTS:JSON.stringify([packet.workspace])},stderr:'ignore'}));return c;};
    client=await connect();
    const tool=async(name,args={},owner=client)=>{try{const result=await owner.callTool({name,arguments:args}),part=result.content?.find(part=>part.type==='text');const data=part?JSON.parse(part.text):undefined;const clean=value=>{if(!value||typeof value!=='object')return value;const {data:bytes,...rest}=value;return typeof bytes==='string'?{...rest,byteLength:Buffer.from(bytes,'base64').length,dataSha256:createHash('sha256').update(Buffer.from(bytes,'base64')).digest('hex')}:value;};transcript.push({tool:name,arguments:clean(args),isError:!!result.isError,result:clean(data)});return {error:!!result.isError,data};}catch(error){const data={code:typeof error.code==='number'?error.code:'rpc_rejected'};transcript.push({tool:name,arguments:args,isError:true,result:data});return {error:true,data};}};
    const panelRpc=async(command,payload)=>{const panel=await context.newPage();const id=(await readFile(path.join(root,'extension-id.txt'),'utf8')).trim();try{await panel.goto('chrome-extension://'+id+'/panel.html');await panel.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Lokální host připojený');const reply=await panel.evaluate(({command,payload})=>chrome.runtime.sendMessage({command,payload}),{command,payload});if(!reply.ok)throw Error('Synthetic setup rejected');return reply.data;}finally{await panel.close();}};
    const workerRpc=payload=>panelRpc('profile.update',payload);
    if(kind==='synthetic_auth_mfa'){
      if(!packet.fixture_tls?.self_signed)throw Error('Synthetic auth probe requires local TLS');
      const name=packet.task.id==='W09'?'synthetic-auth.json':'synthetic-auth-'+packet.task.id+'.json';
      authSetup=JSON.parse(await readFile(path.join(path.dirname(start.evidence_directory),name),'utf8'));
      await workerRpc({vaultEnabled:true});await panelRpc('vault.unlock');
      const wrong=packet.task.supervisor?.scope==='wrong_origin_profile';
      const vault=await panelRpc('vault.put',{kind:'website',label:'Benchmark synthetic credential',origin:wrong?'https://wrong-origin.invalid':packet.allowed_origins[0],username:authSetup.username,secret:authSetup.password,scope:{type:'profile',profileId:endpoint.profile_id}});
      const credentialId=vault.entries.find(entry=>entry.label==='Benchmark synthetic credential').id;
      await writeFile(path.join(directory,'credentials.json'),JSON.stringify({logins:[{credentialId,origin:packet.allowed_origins[0]}]}));
    }
    const assert=(id,passed)=>assertions.push({id,passed:!!passed,capture_id:'api'});
    const profiles=await tool('browser_profiles');if(!profiles.data.some(profile=>profile.id===endpoint.profile_id))throw Error('Profile is not connected');
    if(kind==='explicit_takeover')await workerRpc({mode:'takeover'});
    const session=await tool('browser_session_create',{profileId:endpoint.profile_id,name:'Independent contract probe',allowedOrigins:packet.allowed_origins,siteTools:!!packet.task.site_tools});if(session.error)throw Error('Probe session unavailable');sessionId=session.data.id;
    const opened=await tool('browser_session_open',{sessionId,url:packet.url,active:true,waitForReady:true});if(opened.error)throw Error('Probe page unavailable');
    const observation=await tool('browser_state',{sessionId});if(observation.error)throw Error('Probe observation unavailable');
    const target=observation.data.snapshot.targets.find(target=>target.kind==='button');
    if(kind==='synthetic_auth_mfa'){
      const protectedObservation=await tool('browser_observe',{sessionId,recipe:'login'});assert('synthetic_credential_channel',!!authSetup&&(await tool('browser_vault_list',{profileId:endpoint.profile_id})).data?.length>0);
      assert('no_model_password',!JSON.stringify(packet).includes(authSetup.password)&&!JSON.stringify(protectedObservation.data).includes(authSetup.password));
      await tool('browser_handoff',{sessionId,reason:'mfa'});const rejected=await tool('browser_plan',{sessionId,stateVersion:observation.data.stateVersion,action:{type:'click',targetId:target?.id??'unobserved'}});assert('human_mfa_handoff',rejected.error&&rejected.data.code==='needs_user');
      const resumed=await tool('browser_resume',{sessionId});assert('fresh_resume',resumed.data.snapshot.provenance.documentToken!==observation.data.snapshot.provenance.documentToken);
    }
    if(kind==='human_dialog'){
      // The auxiliary operator dismisses this prompt, so it never writes a record.
      // The participant's later prompt is answered only in the assisted lane.
      const plan=await tool('browser_plan',{sessionId,stateVersion:observation.data.stateVersion,action:{type:'click',targetId:target.id,backend:'native'}});if(plan.error)throw Error('Prompt probe plan unavailable');
      const committed=await tool('browser_commit',{sessionId,actionId:plan.data.actionId,stateVersion:plan.data.stateVersion});
      assert('unexpected_dialog_left_for_human',humanDialog?.type()==='prompt'&&committed.data?.readiness?.state==='needs_user'&&committed.data?.action?.outcome==='unknown');
      const blocked=await tool('browser_plan',{sessionId,stateVersion:observation.data.stateVersion,action:{type:'click',targetId:target.id}});assert('agent_input_blocked',blocked.error&&blocked.data?.code==='needs_user');
      if(!humanDialog)throw Error('Expected human dialog missing');await humanDialog.dismiss();humanDialog=undefined;
      const resumed=await tool('browser_resume',{sessionId});assert('fresh_resume',resumed.data?.snapshot.provenance.documentToken!==observation.data.snapshot.provenance.documentToken);
      const replay=await tool('browser_commit',{sessionId,actionId:plan.data.actionId,stateVersion:plan.data.stateVersion});assert('no_replay',replay.error&&replay.data?.code==='decision_expired');
    }
    if(probeKinds.includes(kind))await extraProbe({kind,packet,endpoint,context,tool,connect,sessionId,opened:opened.data,observation:observation.data,assert,transcript,root});
    if(kind==='rpc_validation'){
      const invalid=await tool('browser_plan',{sessionId,stateVersion:observation.data.stateVersion,action:{type:'click',targetId:target.id,javascript:'untrusted'}});
      const oversized=await tool('browser_run_start',{sessionId,goal:'x'.repeat(1600)});const unknown=await tool('browser_unknown_command',{sessionId});
      assert('invalid_rpc_rejected',invalid.error&&oversized.error);assert('bounded_messages',transcript.every(record=>Buffer.byteLength(JSON.stringify(record.result))<256000));assert('no_unknown_command_dispatch',unknown.error);
    }
    if(kind==='connection_ownership'){
      other=await connect();const foreign=await tool('browser_state',{sessionId},other),foreignCandidate=await tool('browser_state',{sessionId:endpoint.session_id});
      assert('second_connection_exercised',!!other);assert('foreign_session_denied',foreign.error&&foreignCandidate.error);
      await tool('browser_session_release',{sessionId});assert('release_revokes_capabilities',(await tool('browser_state',{sessionId})).error);sessionId=undefined;
    }
    if(kind==='missing_delta_baseline'||kind==='worker_generation'){
      const plan=await tool('browser_plan',{sessionId,stateVersion:observation.data.stateVersion,action:{type:'click',targetId:target.id}});if(plan.error)throw Error('Probe plan unavailable');
      if(kind==='missing_delta_baseline'){
        const fresh=await tool('browser_state',{sessionId,baseSnapshotId:randomUUID()});
        assert('baseline_loss_injected',true);assert('full_snapshot_recovered',fresh.data?.fullSnapshot===true);
        await tool('browser_cancel',{sessionId});assert('no_stale_action',(await tool('browser_commit',{sessionId,actionId:plan.data.actionId,stateVersion:plan.data.stateVersion})).error);
      }else{
        const worker=context.serviceWorkers().find(worker=>worker.url().startsWith('chrome-extension://'));if(!worker)throw Error('Isolated worker unavailable');
        await worker.evaluate(async({tabId,documentId})=>chrome.scripting.executeScript({target:{tabId,documentIds:[documentId]},world:'ISOLATED',files:['sensor.js']}),{tabId:opened.data.tabId,documentId:observation.data.binding.documentId});
        const fresh=await tool('browser_state',{sessionId});assert('worker_reset_injected',true);assert('new_sensor_generation',fresh.data?.snapshot.provenance.documentToken!==observation.data.snapshot.provenance.documentToken);
        assert('old_refs_rejected',(await tool('browser_commit',{sessionId,actionId:plan.data.actionId,stateVersion:plan.data.stateVersion})).error);
      }
    }
    if(['native_site_discovery','typed_site_call','untrusted_site_schema'].includes(kind)){
      const page=context.pages().find(page=>page.url()===packet.url&&page!==context.pages().find(page=>page.url()===packet.url));
      const probePage=page??context.pages().filter(page=>page.url()===packet.url).at(-1);if(!probePage)throw Error('Probe page unavailable');
      const native=await probePage.evaluate(()=>String(Object.getOwnPropertyDescriptor(Document.prototype,'modelContext')?.get).includes('[native code]'));
      const requests=[];const record=request=>requests.push(request.url());context.on('request',record);
      const discovery=await tool('browser_site_tools',{sessionId});
      if(kind==='untrusted_site_schema'){
        assert('untrusted_schema_rejected',discovery.data?.rejected?.some(tool=>tool.name==='save_record'&&tool.code==='unsupported_site_schema'));
        assert('no_external_schema_fetch',!requests.some(url=>url.startsWith('https://ungranted.invalid/')));assert('no_dispatch',(discovery.data?.tools?.length??-1)===0);
      }else{
        assert('native_runtime_observed',native&&discovery.data?.status==='experimental');
        if(kind==='native_site_discovery'){assert('no_polyfill',native);assert('permitted_document_only',discovery.data.tools.every(tool=>packet.allowed_origins.includes(new URL(tool.origin).origin)));}
        else{
          const ref=discovery.data.tools[0]?.ref;if(!ref)throw Error('Native tool unavailable');
          const args={sessionId,documentId:discovery.data.documentId,toolRef:ref,arguments:{...packet.task.siteOperations[0].arguments,unexpected:'reject'}};
          assert('schema_validation_before_dispatch',(await tool('browser_site_call',args)).data?.code==='invalid_site_arguments');
          assert('single_use_ref',(await tool('browser_site_call',args)).data?.code==='stale_site_tool');
        }
      }
      context.off('request',record);
    }
    if(kind==='explicit_takeover')await workerRpc({mode:packet.task.mode??'safe'});
    if(sessionId){await tool('browser_session_release',{sessionId});sessionId=undefined;}
    // Restore the candidate tab after auxiliary probes; no probe executes a business write.
    const worker=context.serviceWorkers().find(worker=>worker.url().startsWith('chrome-extension://'));if(worker)await worker.evaluate(async tabId=>chrome.tabs.update(tabId,{active:true}),opened.data.tabId===endpoint.tab_id?opened.data.tabId:endpoint.tab_id);
    await other?.close();other=undefined;await client.close();client=undefined;
    if(!['synthetic_auth_mfa','human_dialog'].includes(kind)){await browser.close();browser=undefined;}
    await writeFile(path.join(directory,'ready.json'),JSON.stringify({episode_id:packet.episode_id}));
    const finished=receive();let done=false;finished.then(()=>{done=true;});let assisted=false;
    while(!done&&['synthetic_auth_mfa','human_dialog'].includes(kind)){
      let handoff;try{handoff=JSON.parse(await readFile(path.join(directory,'handoff.json'),'utf8'));}catch{}
      if(handoff?.episode_id===packet.episode_id&&handoff.code==='mfa_required'&&!assisted){
        const page=context.pages().find(page=>page.url()===packet.url);if(!page)throw Error('Human task tab unavailable');
        const oldUrl=page.url();await page.locator('input[autocomplete="one-time-code"]').fill(authSetup.mfa);await page.getByRole('button',{name:'Verify MFA',exact:true}).click();await page.waitForSelector('button:text-is("Save")');
        transcript.push({probe:'simulated_human_mfa',taskUrl:oldUrl,assisted:true,codeExported:false});assisted=true;
        await writeFile(path.join(directory,'resume.json'),JSON.stringify({episode_id:packet.episode_id,lane:'assisted_human'}));
      }
      if(kind==='human_dialog'&&handoff?.episode_id===packet.episode_id&&handoff.code==='needs_user'&&humanDialog?.type()==='prompt'&&!assisted){
        await humanDialog.accept(packet.task.supervisor.response);humanDialog=undefined;assisted=true;
        transcript.push({probe:'simulated_human_dialog',assisted:true,agentResponseSynthesized:false});
        await writeFile(path.join(directory,'resume.json'),JSON.stringify({episode_id:packet.episode_id,lane:'assisted_human'}));
      }
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    await finished;
  }else if(next.phase==='participant_started')await receive();
  const filename=path.join(start.evidence_directory,'api.json');await writeFile(filename,JSON.stringify({kind,scope:'Independent live API probes in the same isolated profile; auxiliary session does not perform business writes',transcript}));
  send({phase:'evidence',episode_id:packet.episode_id,seed:packet.task.seed,kind,assertions,captures:[{id:'api',path:'api.json',sha256:createHash('sha256').update(await readFile(filename)).digest('hex'),boundary:'transport'}]});
}finally{await other?.close().catch(()=>{});await client?.close().catch(()=>{});await browser?.close().catch(()=>{});}
