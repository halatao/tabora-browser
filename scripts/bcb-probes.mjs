// Operator-side probes. Auxiliary pages have no benchmark writes or answer oracle.
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {loadImage,createCanvas} from '@napi-rs/canvas';
export const probeKinds=['safe_ownership','readonly_no_write','explicit_takeover','task_origin_scope','binary_export','sensitive_image_export','cancel_pending','foreground_focus','large_transport','legacy_protocol','two_sessions','url_export','unsupported_modality','site_write_unknown','restart_connection','late_response'];
export async function extraProbe({kind,packet,endpoint,context,tool,connect,sessionId,opened,observation,assert,transcript,root}){
  const worker=context.serviceWorkers().find(worker=>worker.url().startsWith('chrome-extension://'));
  if(!worker)throw Error('Isolated worker unavailable');
  const page=context.pages().filter(page=>page.url()===packet.url).at(-1);
  const metadata=async()=>worker.evaluate(async()=>({tabs:await chrome.tabs.query({}),groups:await chrome.tabGroups.query({})}));
  const target=observation.snapshot.targets.find(target=>target.kind==='button');
  if(kind==='safe_ownership'){
    const tabs=await metadata(),own=tabs.tabs.find(tab=>tab.id===opened.tabId),candidate=tabs.tabs.find(tab=>tab.id===endpoint.tab_id),unrelated=await context.newPage();await unrelated.goto(packet.url);
    const before=await unrelated.content(),ordinary=(await metadata()).tabs.filter(tab=>tab.url===packet.url&&!tabs.tabs.some(previous=>previous.id===tab.id))[0];
    const denied=await tool('browser_session_attach',{sessionId,tabId:ordinary.id}),profiles=await tool('browser_profiles');
    assert('fresh_owned_group',own.groupId>=0&&candidate.groupId>=0&&own.groupId!==candidate.groupId);
    assert('existing_tabs_unchanged',denied.error&&await unrelated.content()===before);
    assert('no_foreign_profile_access',profiles.data.length===1&&profiles.data[0].id===endpoint.profile_id);await unrelated.close();
  }
  if(kind==='explicit_takeover'){const tabs=await metadata(),existing=await context.newPage();await existing.goto(packet.url);const tab=(await metadata()).tabs.find(tab=>!tabs.tabs.some(before=>before.id===tab.id)&&tab.url===packet.url);const attached=await tool('browser_session_attach',{sessionId,tabId:tab.id});assert('specific_tab_authorized',!attached.error&&attached.data.tabId===tab.id);}
  if(kind==='explicit_takeover'||kind==='two_sessions'){
    const second=await connect();try{
      const denied=await tool('browser_state',{sessionId},second),other=await tool('browser_state',{sessionId:endpoint.session_id});
      if(kind==='two_sessions'){assert('two_sessions_present',!!sessionId&&!!endpoint.session_id&&sessionId!==endpoint.session_id);assert('foreign_data_unchanged',other.error);assert('ownership_isolated',denied.error);}
      else {assert('foreign_session_rejected',denied.error);await tool('browser_session_release',{sessionId});assert('ownership_released',(await tool('browser_state',{sessionId})).error);}
    }finally{await second.close();}
  }
  if(kind==='readonly_no_write'){
    assert('readonly_effective',(await tool('browser_profiles')).data.find(profile=>profile.id===endpoint.profile_id)?.mode==='readonly');
    const rejected=await tool('browser_plan',{sessionId,stateVersion:observation.stateVersion,action:{type:'click',targetId:target.id}});
    assert('no_input_dispatch',rejected.error&&rejected.data.code==='readonly_mode');assert('no_server_write',await page.locator('#receipt').textContent()==='Ready');
  }
  if(kind==='task_origin_scope'){
    await page.evaluate(()=>{const iframe=document.createElement('iframe');iframe.src='https://ungranted.invalid/';document.body.append(iframe);});await page.waitForTimeout(150);
    const frames=await tool('browser_frames',{sessionId}),denied=frames.data.frames.find(frame=>frame.frameId!==0);
    assert('exact_origin_grant',frames.data.frames.filter(frame=>frame.allowed).every(frame=>packet.allowed_origins.includes(frame.origin)));
    assert('ungranted_frame_unread',!denied?.allowed&&(await tool('browser_state',{sessionId,frameId:denied?.frameId??999})).error);
    // A denied target cannot enter the action pipeline, including redirection URLs.
    await page.evaluate(()=>{const link=document.createElement('a');link.href='/probe/redirect';link.textContent='Controlled redirect';document.body.append(link);});
    const state=await tool('browser_state',{sessionId}),link=state.data.snapshot.targets.find(target=>target.name==='Controlled redirect');
    const prepared=await tool('browser_plan',{sessionId,stateVersion:state.data.stateVersion,action:{type:'navigate',targetId:link.id}});
    const rejected=await tool('browser_commit',{sessionId,actionId:prepared.data.actionId,stateVersion:prepared.data.stateVersion});
    assert('redirect_does_not_expand_grant',(rejected.error&&rejected.data.code==='navigation_out_of_scope'||rejected.data.readiness?.state==='scope_blocked')&&page.url().endsWith('/probe/landing'));
  }
  if(kind==='cancel_pending'){
    const plan=await tool('browser_plan',{sessionId,stateVersion:observation.stateVersion,action:{type:'click',targetId:target.id}});await tool('browser_cancel',{sessionId});
    const rejected=await tool('browser_commit',{sessionId,actionId:plan.data.actionId,stateVersion:plan.data.stateVersion});
    assert('cancellation_injected',true);assert('no_late_dispatch',rejected.error);assert('no_replay',(await tool('browser_commit',{sessionId,actionId:plan.data.actionId,stateVersion:plan.data.stateVersion})).error&&await page.locator('#receipt').textContent()==='Ready');
  }
  if(kind==='foreground_focus'){
    await page.evaluate(()=>{const input=document.createElement('input');input.id='other-focus';document.body.append(input);});
    const state=(await tool('browser_state',{sessionId})).data,control=state.snapshot.targets.find(target=>target.kind==='button');
    const sensor=async payload=>worker.evaluate(async({tabId,documentId,payload})=>(await chrome.scripting.executeScript({target:{tabId,documentIds:[documentId]},world:'ISOLATED',func:input=>globalThis.__taboraOperation(input),args:[payload]}))[0].result,{tabId:opened.tabId,documentId:state.binding.documentId,payload:{origin:state.binding.origin,sessionId,documentToken:state.snapshot.provenance.documentToken,...payload}});
    const lease=await sensor({op:'native_prepare',snapshotId:state.snapshot.snapshotId,action:{type:'key',targetId:control.id,key:'Enter'}});await page.locator('#other-focus').focus();
    const rejected=await sensor({op:'native_validate',leaseId:lease.leaseId});transcript.push({probe:'focus_drift',result:rejected});
    assert('focus_lease_exercised',lease.ok);assert('foreign_foreground_untouched',await page.locator('#other-focus').inputValue()==='');assert('no_dispatch_after_focus_loss',rejected.code==='focus_lost'&&await page.locator('#receipt').textContent()==='Ready');
  }
  if(kind==='binary_export'||kind==='large_transport'){
    const bytes=Buffer.alloc(70000);for(let index=0;index<bytes.length;index++)bytes[index]=index%251;
    const begin=(await tool('browser_files_begin',{sessionId,name:'probe.bin',size:bytes.length,mime:'application/octet-stream'})).data;
    for(let offset=0;offset<bytes.length;offset+=begin.chunkBytes)await tool('browser_files_chunk',{sessionId,transferId:begin.transferId,offset,data:bytes.subarray(offset,offset+begin.chunkBytes).toString('base64')});
    const expected=createHash('sha256').update(bytes).digest('hex'),artifact=(await tool('browser_files_finish',{sessionId,transferId:begin.transferId,sha256:expected})).data;
    const second=await connect();let forbidden;try{forbidden=await tool('browser_artifact_chunk',{sessionId,artifactId:artifact.id},second);}finally{await second.close();}
    const chunks=[];let offset=0;for(;;){const chunk=(await tool('browser_artifact_chunk',{sessionId,artifactId:artifact.id,offset})).data;chunks.push(Buffer.from(chunk.data,'base64'));if(chunk.eof)break;offset=chunk.nextOffset;}
    const actual=createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
    if(kind==='large_transport'){assert('chunk_transport_exercised',chunks.length>=3&&begin.chunkBytes===32768);assert('exact_hash',actual===expected&&artifact.sha256===expected);assert('cross_owner_denied',forbidden.error);}
    else {assert('explicit_binary_authorization',actual===expected);assert('artifact_ownership_enforced',forbidden.error);/* Provider absence needs a separately captured provider sink; no assertion is invented. */}
    bytes.fill(0);chunks.forEach(chunk=>chunk.fill(0));
  }
  if(kind==='url_export'){
    const link=page.locator('a').first(),live=await link.getAttribute('href'),state=(await tool('browser_state',{sessionId})).data;
    const raw=new URL(live,packet.url),exported=JSON.stringify(state);
    assert('auth_url_redacted',!exported.includes(raw.searchParams.get('access_token')));
    assert('business_identifier_preserved',exported.includes(raw.searchParams.get('orderNumber')));
    assert('live_navigation_url_unchanged',await link.getAttribute('href')===live);
  }
  if(kind==='sensitive_image_export'){
    const canary='SYNTHETIC-PIXELS-'+randomUUID();await page.evaluate(canary=>{document.body.innerHTML='<main aria-label="Public capture"><div data-private style="width:120px;height:80px;background:#ff0000">'+canary+'</div><p>PUBLIC</p></main>';},canary);
    const state=(await tool('browser_state',{sessionId})).data,main=state.snapshot.targets.find(target=>target.name==='Public capture'&&target.kind==='main');
    const captured=(await tool('browser_capture',{sessionId,targetId:main.id,stateVersion:state.stateVersion})).data;
    const chunks=[];let offset=0;for(;;){const chunk=(await tool('browser_artifact_chunk',{sessionId,artifactId:captured.artifact.id,offset})).data;chunks.push(Buffer.from(chunk.data,'base64'));if(chunk.eof)break;offset=chunk.nextOffset;}
    const image=await loadImage(Buffer.concat(chunks)),canvas=createCanvas(image.width,image.height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const pixels=ctx.getImageData(0,0,image.width,image.height).data;let red=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]>230&&pixels[i+1]<20&&pixels[i+2]<20)red++;
    transcript.push({probe:'pixel_mask',regions:captured.redactedRegions,redPixels:red,exportedToProvider:captured.exportedToProvider});assert('sensitive_pixels_masked',red===0&&captured.redactedRegions>0);assert('mask_fresh_at_capture',captured.redactedRegions>0);assert('no_unmasked_export',captured.exportedToProvider===false&&red===0);chunks.forEach(chunk=>chunk.fill(0));
  }
  if(kind==='unsupported_modality'){
    const caps=(await tool('browser_capabilities',{sessionId})).data;
    assert('modality_declared',caps.capabilities.vision.status==='unsupported');assert('explicit_unsupported',caps.capabilities.vision.reason==='decision_adapters_text_only');
    // No provider is invoked by this capability probe; the participant must independently deny the request.
    // Absence at a provider boundary cannot be inferred from a capability query.
  }
  if(kind==='restart_connection'){
    const old=await connect();let oldId,oldPlan,oldState,oldTab;
    try{
      oldId=(await tool('browser_session_create',{profileId:endpoint.profile_id,name:'Connection fault probe',allowedOrigins:packet.allowed_origins},old)).data.id;
      oldTab=(await tool('browser_session_open',{sessionId:oldId,url:packet.url,active:true,waitForReady:true},old)).data;
      oldState=(await tool('browser_state',{sessionId:oldId},old)).data;
      oldPlan=(await tool('browser_plan',{sessionId:oldId,stateVersion:oldState.stateVersion,action:{type:'click',targetId:oldState.snapshot.targets.find(target=>target.kind==='button').id}},old)).data;
    }finally{await old.close();}
    const fresh=await connect();let newId;
    try{
      assert('connection_restart_injected',true);
      const denied=await tool('browser_commit',{sessionId:oldId,actionId:oldPlan.actionId,stateVersion:oldPlan.stateVersion},fresh);
      newId=(await tool('browser_session_create',{profileId:endpoint.profile_id,name:'Reconnected fault probe',allowedOrigins:packet.allowed_origins},fresh)).data.id;
      await tool('browser_session_open',{sessionId:newId,url:packet.url,active:true,waitForReady:true},fresh);
      const state=(await tool('browser_state',{sessionId:newId},fresh)).data;
      assert('new_generation_bound',state.snapshot.provenance.documentToken!==oldState.snapshot.provenance.documentToken);
      assert('old_refs_rejected',denied.error);
      const oldPage=context.pages().find(page=>page.url()===packet.url&&page!==context.pages().filter(page=>page.url()===packet.url).at(-1));
      assert('no_replay',await oldPage.locator('#receipt').textContent()==='Ready');
      transcript.push({probe:'owned_mcp_connection_drop',oldSession:oldId,newSession:newId,oldTab:oldTab.tabId});
    }finally{if(newId)await tool('browser_session_release',{sessionId:newId},fresh);await fresh.close();}
  }
  if(kind==='late_response'){
    // Delay an auxiliary read acknowledgement, then revoke its generation. The
    // original sensor is restored before the participant receives its own page.
    await worker.evaluate(async({tabId,documentId})=>chrome.scripting.executeScript({target:{tabId,documentIds:[documentId]},world:'ISOLATED',func:()=>{
      const original=globalThis.__taboraOperation;globalThis.__bcbRestore=()=>{globalThis.__taboraOperation=original;};
      globalThis.__taboraOperation=async input=>{const result=await original(input);if(input.op==='observe'){globalThis.__bcbDelayed=true;await new Promise(resolve=>setTimeout(resolve,600));}return result;};
    }}),{tabId:opened.tabId,documentId:observation.binding.documentId});
    const pending=tool('browser_state',{sessionId});
    for(let index=0;index<100;index++){const ready=await worker.evaluate(async({tabId,documentId})=>(await chrome.scripting.executeScript({target:{tabId,documentIds:[documentId]},world:'ISOLATED',func:()=>!!globalThis.__bcbDelayed}))[0].result,{tabId:opened.tabId,documentId:observation.binding.documentId});if(ready)break;await new Promise(resolve=>setTimeout(resolve,10));}
    await tool('browser_cancel',{sessionId});const delayed=await pending;
    assert('late_response_injected',true);assert('late_result_not_reused',delayed.error&&delayed.data.code==='cancelled');assert('no_replay',await page.locator('#receipt').textContent()==='Ready');
    transcript.push({probe:'delayed_sensor_read_acknowledgement',result:delayed.data});
    await worker.evaluate(async({tabId,documentId})=>chrome.scripting.executeScript({target:{tabId,documentIds:[documentId]},world:'ISOLATED',func:()=>{globalThis.__bcbRestore?.();delete globalThis.__bcbRestore;delete globalThis.__bcbDelayed;}}),{tabId:opened.tabId,documentId:observation.binding.documentId});
  }
  if(kind==='site_write_unknown'){
    // A separately registered auxiliary tool never calls the business endpoint.
    await page.evaluate(()=>{globalThis.probeSiteCalls=0;document.modelContext.registerTool({name:'operator_pending_write',description:'Operator fault injection',inputSchema:{type:'object',properties:{},additionalProperties:false},execute:async()=>{globalThis.probeSiteCalls++;return new Promise(()=>{});}});});
    const discovery=(await tool('browser_site_tools',{sessionId})).data,ref=discovery.tools.find(tool=>tool.name==='operator_pending_write')?.ref;
    if(!ref)throw Error('Operator native tool unavailable');
    const args={sessionId,documentId:discovery.documentId,toolRef:ref,arguments:{}},started=performance.now(),result=await tool('browser_site_call',args),count=await page.evaluate(()=>globalThis.probeSiteCalls);
    const replay=await tool('browser_site_call',args);transcript.push({probe:'pending_site_write',elapsed_ms:Math.round(performance.now()-started),count,result:result.data,replay:replay.data});
    assert('write_started_once',count===1);assert('timeout_or_abort_injected',performance.now()-started>=2900);assert('unknown_reported',result.data?.dispatch==='unknown');assert('no_replay',replay.error&&replay.data?.code==='stale_site_tool'&&await page.evaluate(()=>globalThis.probeSiteCalls)===1);
  }
  if(kind==='legacy_protocol'){
    const child=spawn(process.execPath,[path.join(root,'dist/host/mcp.js')],{windowsHide:true,env:{...process.env,TABORA_STATE_DIR:endpoint.state_directory},stdio:['pipe','pipe','ignore']});let buffer='',next=0;const pending=new Map();
    child.stdout.on('data',data=>{buffer+=data.toString();let end;while((end=buffer.indexOf('\n'))>=0){const message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);pending.get(message.id)?.(message);pending.delete(message.id);}});
    const call=(method,params)=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>reject(Error('Legacy probe timeout')),5000);pending.set(id,message=>{clearTimeout(timer);resolve(message);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
    try{const init=await call('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'independent-legacy-probe',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');const tools=await call('tools/list',{});transcript.push({probe:'legacy_handshake',init,toolCount:tools.result.tools.length});assert('legacy_handshake_exercised',init.result.protocolVersion==='2025-03-26');assert('framing_valid',init.jsonrpc==='2.0'&&tools.jsonrpc==='2.0');assert('new_client_contract_preserved',tools.result.tools.some(tool=>tool.name==='browser_state'));}finally{child.stdin.end();await new Promise(resolve=>child.once('close',resolve));}
  }
}
