import {spawn,execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

const base=path.resolve('.test-state');await mkdir(base,{recursive:true});
const directory=await mkdtemp(path.join(base,'files-browser-')),workspace=path.join(directory,'workspace'),judge=path.join(directory,'judge'),state=path.join(directory,'state');
const benchmark=path.resolve('../browser-capability-bench/bcb.py'),python=process.env.TABORA_BENCH_PYTHON??'python';
const child=spawn(python,[benchmark,'serve','--workspace',workspace,'--judge-dir',judge,'--port','0','--seed','101'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
child.stderr.on('data',data=>process.stderr.write(data));
const origin=await new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(new Error('File benchmark startup timeout')),15000);child.once('error',reject);child.stdout.on('data',chunk=>{data+=chunk;const index=data.indexOf('\n');if(index>=0){clearTimeout(timer);resolve(JSON.parse(data.slice(0,index)).public_url);}});});
const extension=path.join(directory,'extension');await cp('dist/extension',extension,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));manifest.host_permissions=['http://127.0.0.1/*'];await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
const extensionId=(await readFile('extension-id.txt','utf8')).trim(),contexts=[],clients=[],timings=[],checks=[];
const watchdog=setTimeout(()=>{console.error('File browser test timed out');process.exit(1);},180000);
let context,profileId,client,transport,panel;
async function tool(name,args={},expectedError){
  const start=performance.now(),reply=await client.callTool({name,arguments:args}),data=JSON.parse(reply.content.find(c=>c.type==='text').text);
  timings.push({tool:name,ms:Math.round(performance.now()-start)});
  if(expectedError){assert(reply.isError,`${name} should fail`);assert.equal(data.code,expectedError);}else assert(!reply.isError,`${name}: ${JSON.stringify(data)}`);
  return data;
}
function grade(id){return JSON.parse(execFileSync(python,[benchmark,'grade','--judge-dir',judge,'--case',id],{windowsHide:true,encoding:'utf8'})).cases[0];}
async function session(variant){
  const id=`BCB-C20-${variant}`,s=await tool('browser_session_create',{profileId,name:variant}),url=`${origin}/task/${id}?session=${s.id}`,opened=await tool('browser_session_open',{sessionId:s.id,url,active:true,waitForReady:true});
  assert(opened.attached,JSON.stringify(opened));
  const observation=await tool('browser_observe',{sessionId:s.id,recipe:'all'}),file=observation.snapshot.targets.find(t=>t.kind==='file');assert(file,'File input must be observed');
  const page=context.pages().find(p=>p.url()===url);assert(page);return {id,s,observation,file,page,binding:opened.binding};
}
async function upload(task,artifacts,expectedError){return tool('browser_upload',{sessionId:task.s.id,targetId:task.file.id,stateVersion:task.stateVersion??task.binding.documentId+':'+task.observation.snapshot.documentToken,artifactIds:artifacts.map(a=>a.id)},expectedError);}
async function waitUpload(task){await task.page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('Received'),undefined,{timeout:10000});assert(grade(task.id).outcome_passed);}
try{
  context=await chromium.launchPersistentContext(path.join(directory,'chromium'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],env:{...process.env,TABORA_STATE_DIR:state,TABORA_BROWSER_NAME:'File test'},viewport:{width:1100,height:900}});contexts.push(context);
  panel=await context.newPage();await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  await panel.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Lokální host připojený',undefined,{timeout:30000});
  profileId=(await panel.evaluate(()=>chrome.runtime.sendMessage({command:'status'}))).data.profile.id;
  const connect=async()=>{const t=new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/host/mcp.js')],env:{...process.env,TABORA_STATE_DIR:state,TABORA_FILE_ROOTS_B64:Buffer.from(JSON.stringify([workspace])).toString('base64')},stderr:'pipe'});const c=new Client({name:'file-extension-integration',version:'1'});await c.connect(t);clients.push(c);return {c,t};};
  ({c:client,t:transport}=await connect());assert.equal((await client.listTools()).tools.length,47);
  // No panel or picker exists during the first four autonomous cases.
  await panel.close();assert(!context.pages().some(p=>p.url().includes('panel.html')));

  const v1=await session('V01'),meta1=await tool('browser_files_import',{sessionId:v1.s.id,path:path.join(workspace,v1.id,'invoice.pdf')});
  const dispatched=await upload(v1,[meta1]);assert.equal(dispatched.dispatch,'sent');assert.equal(dispatched.businessOutcomeVerified,false);await waitUpload(v1);checks.push('V01 automatic path import and server hash, panel closed');
  await upload(v1,[meta1],'stale_snapshot');assert.equal(grade(v1.id).uploads,1);

  const v2=await session('V02'),files=[];
  for(const name of ['one.txt','two.txt']){
    const bytes=await readFile(path.join(workspace,v2.id,name)),transfer=await tool('browser_files_begin',{sessionId:v2.s.id,name,size:bytes.length,mime:'text/plain'});
    for(let offset=0;offset<bytes.length;offset+=32768)await tool('browser_files_chunk',{sessionId:v2.s.id,transferId:transfer.transferId,offset,data:bytes.subarray(offset,offset+32768).toString('base64')});
    files.push(await tool('browser_files_finish',{sessionId:v2.s.id,transferId:transfer.transferId,sha256:createHash('sha256').update(bytes).digest('hex')}));
  }
  await upload(v2,files);await waitUpload(v2);checks.push('V02 multiple client-stream attachments, bounded chunks and hashes');
  const v3=await session('V03'),forbidden=path.join(judge,'forbidden.txt');await writeFile(forbidden,'synthetic forbidden');
  await tool('browser_files_import',{sessionId:v3.s.id,path:forbidden},'needs_file_access');assert(grade(v3.id).outcome_passed);checks.push('V03 non-granted source rejected without upload');

  const v4=await session('V04'),meta4=await tool('browser_files_import',{sessionId:v4.s.id,path:path.join(workspace,v4.id,'interrupted.txt')});await upload(v4,[meta4]);
  await v4.page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('Response unavailable'),undefined,{timeout:10000});assert(grade(v4.id).outcome_passed,JSON.stringify(grade(v4.id)));assert.equal(grade(v4.id).uploads,1);checks.push('V04 interrupted server response, no replay');

  const v6=await session('V06'),start=performance.now(),roots=await tool('browser_files_roots',{sessionId:v6.s.id}),found=await tool('browser_files_find',{sessionId:v6.s.id,rootId:roots[0].id,query:'invoice-latest.txt'});assert.equal(found.files.length,1);
  const meta6=await tool('browser_files_import',{sessionId:v6.s.id,fileRef:found.files[0].fileRef});
  const v2file=await tool('browser_state',{sessionId:v6.s.id});v6.file=v2file.snapshot.targets.find(target=>target.kind==='file');assert(v6.file);v6.stateVersion=v2file.stateVersion;
  await writeFile(path.join(workspace,v6.id,'invoice-latest.txt'),'changed by fixture after snapshot');
  await upload(v6,[meta6]);await waitUpload(v6);checks.push('V06 find/import/V2 hidden-input upload and immutable snapshot, no user action');
  const autonomousFindUploadMs=Math.round(performance.now()-start);
  assert(!context.pages().some(p=>p.url().includes('panel.html')));

  const v8=await session('V08'),source8=path.join(workspace,v8.id,'allowed.txt');await writeFile(source8,'allowed');const meta8=await tool('browser_files_import',{sessionId:v8.s.id,path:source8});
  await tool('browser_files_release',{sessionId:v8.s.id,artifactIds:[meta8.id]});await upload(v8,[meta8],'file_not_owned');assert(grade(v8.id).outcome_passed);checks.push('V08 revoked artifact cannot dispatch');
  const evil=await tool('browser_files_import',{sessionId:v8.s.id,path:path.join(workspace,v1.id,'invoice.pdf')});
  await upload(v8,[evil],'file_type_rejected');assert(grade(v8.id).outcome_passed);checks.push('accept mismatch rejected before input mutation');
  const other=await connect(),saved=client;client=other.c;await tool('browser_files_status',{sessionId:v6.s.id},'session_not_owned');client=saved;checks.push('second MCP connection cannot access files');

  panel=await context.newPage();await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  await panel.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Lokální host připojený');
  const v5=await session('V05'),request=await tool('browser_files_request',{sessionId:v5.s.id,purpose:'Synthetic user-picked attachment',accept:'.txt'});
  await panel.bringToFront();
  await panel.getByText('Synthetic user-picked attachment',{exact:true}).waitFor();
  const [chooser]=await Promise.all([panel.waitForEvent('filechooser'),panel.getByRole('button',{name:'Vybrat přílohu',exact:true}).click()]);
  await chooser.setFiles(path.join(workspace,v5.id,'manual.txt'));
  await panel.getByText('Příloha předaná agentovi.',{exact:true}).waitFor({timeout:20000});
  const status5=await tool('browser_files_status',{sessionId:v5.s.id});assert.equal(status5.requests.find(r=>r.id===request.requestId).state,'ready');
  await upload(v5,status5.files.filter(f=>f.state==='ready'));await waitUpload(v5);checks.push('V05 optional picker request/fulfillment via extension UI (assisted simulation)');
  const v7=await session('V07');await tool('browser_files_request',{sessionId:v7.s.id,purpose:'Synthetic cancellation'});await panel.bringToFront();await panel.getByText('Synthetic cancellation',{exact:true}).waitFor();
  await panel.locator('#file-requests button').filter({hasText:'Zrušit'}).click();
  await panel.waitForFunction(()=>!document.querySelector('#file-requests').textContent.includes('Synthetic cancellation'));
  assert.equal((await tool('browser_files_status',{sessionId:v7.s.id})).requests[0].state,'cancelled');assert(grade(v7.id).outcome_passed);checks.push('V07 explicit request cancel, no upload (assisted simulation)');

  const revoked=await session('V08'),largePath=path.join(workspace,revoked.id,'large.txt');await writeFile(largePath,Buffer.alloc(2*1024*1024,65));
  const large=await tool('browser_files_import',{sessionId:revoked.s.id,path:largePath});
  const unusedTransfer=await tool('browser_files_begin',{sessionId:revoked.s.id,name:'unused.txt',size:0,mime:'text/plain'}),unused=await tool('browser_files_finish',{sessionId:revoked.s.id,transferId:unusedTransfer.transferId});
  const inFlight=client.callTool({name:'browser_upload',arguments:{sessionId:revoked.s.id,targetId:revoked.file.id,stateVersion:revoked.binding.documentId+':'+revoked.observation.snapshot.documentToken,artifactIds:[large.id]}});
  const worker=context.serviceWorkers().find(w=>w.url().startsWith(`chrome-extension://${extensionId}/`));assert(worker);
  // Test-only inspection of the extension's isolated world makes the revoke point deterministic.
  const deadline=Date.now()+10000;let active=false;
  while(Date.now()<deadline&&!active){active=await worker.evaluate(async tabId=>{const result=await chrome.scripting.executeScript({target:{tabId},world:'ISOLATED',func:()=>Boolean(globalThis.__taboraFileTransfer)});return result[0]?.result;},revoked.binding.tabId);}
  assert(active,'Transfer must be in progress before revocation');
  await tool('browser_files_release',{sessionId:revoked.s.id,artifactIds:[unused.id]});
  assert(await worker.evaluate(async tabId=>{const result=await chrome.scripting.executeScript({target:{tabId},world:'ISOLATED',func:()=>Boolean(globalThis.__taboraFileTransfer)});return result[0]?.result;},revoked.binding.tabId),'Releasing an unrelated artifact must preserve this transfer');checks.push('unrelated artifact release preserves an active upload');
  await tool('browser_files_release',{sessionId:revoked.s.id,artifactIds:[large.id]});
  const cancelled=await inFlight;assert(cancelled.isError);const cancelledData=JSON.parse(cancelled.content.find(c=>c.type==='text').text);assert(['cancelled','file_ticket_invalid','file_access_revoked'].includes(cancelledData.code),JSON.stringify(cancelledData));
  assert.equal(await revoked.page.locator('#attachment').evaluate(el=>el.files.length),0);assert.equal(grade(revoked.id).uploads,0);checks.push('in-flight artifact release cancels remaining chunks before dispatch');

  // Replacement, mode change and expired artifact boundaries are regressions, not extra attempts.
  const stale=await session('V03'),staleMeta=await tool('browser_files_import',{sessionId:stale.s.id,path:path.join(workspace,v2.id,'one.txt')});
  await stale.page.evaluate(()=>{const old=document.querySelector('#attachment'),replacement=old.cloneNode();old.replaceWith(replacement);});await upload(stale,[staleMeta],'stale_snapshot');
  await panel.evaluate(()=>chrome.runtime.sendMessage({command:'profile.update',payload:{mode:'readonly'}}));
  await tool('browser_upload',{sessionId:stale.s.id,targetId:stale.file.id,stateVersion:'doc:token',artifactIds:[staleMeta.id]},'readonly_mode');checks.push('stale replaced input and readonly writes denied');
  const result={passed:true,recordedAt:new Date().toISOString(),productVersion:JSON.parse(await readFile('package.json','utf8')).version,nodeVersion:process.version,kind:'executor_integration_not_model_benchmark',seed:101,autonomousFindUploadMs,humanActionsInAutonomousCases:0,checks,timings,oracle:JSON.parse(execFileSync(python,[benchmark,'grade','--judge-dir',judge],{windowsHide:true,encoding:'utf8'})),limitations:['Only C20 file subset, not full BCB','V05/V07 use simulated user UI actions','Internal properties need independent E2 probes for comparisons','No external agent/model latency measured','Upload tasks open active tabs; background readiness not covered','Timing starts after target-page observation and includes oracle verification']};
  await mkdir('reports/files',{recursive:true});await writeFile('reports/files/latest.json',JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,checks:checks.length,autonomousFindUploadMs,report:'reports/files/latest.json'}));
}finally{
  clearTimeout(watchdog);for(const c of clients)await c.close().catch(()=>{});for(const ctx of contexts)await ctx.close().catch(()=>{});
  const exited=child.exitCode===null?once(child,'exit'):Promise.resolve();child.kill();await exited;
  assert.equal(path.dirname(directory),base);await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
