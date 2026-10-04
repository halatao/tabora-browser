import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,readdir,open} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ArtifactStore,type FileScope} from '../src/host/artifacts.js';
import {configuredFileRoots} from '../src/host/file-roots.js';
import {BrokerRouter} from '../src/host/broker-router.js';
import {RunController} from '../src/host/run-controller.js';
import {FILE_CHUNK_BYTES,FILE_MAX_BYTES,fileChunkSchema} from '../src/file-contract.js';

async function fixture(){
  const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const dir=await mkdtemp(path.join(base,'artifacts-')),root=path.join(dir,'workspace');await mkdir(root);
  const store=new ArtifactStore(dir),scope:FileScope={owner:'agent',profileId:randomUUID(),sessionId:randomUUID()};await store.registerOwner(scope.owner,[root]);
  return {dir,root,store,scope,close:async()=>{await store.close();assert.equal(path.dirname(dir),base);await rm(dir,{recursive:true,force:true,maxRetries:3});}};
}

test('installer file roots preserve JSON quotes, spaces and Unicode through encoded configuration',()=>{
  const roots=['C:\\synthetic path\\Ondřej'],json=JSON.stringify(roots),encoded=Buffer.from(json).toString('base64');
  assert.deepEqual(configuredFileRoots({TABORA_FILE_ROOTS_B64:encoded},'C:\\fallback'),roots);
  assert.deepEqual(configuredFileRoots({TABORA_FILE_ROOTS:json},'C:\\fallback'),roots);
  assert.deepEqual(configuredFileRoots({},'C:\\fallback'),['C:\\fallback']);
  assert.deepEqual(configuredFileRoots({TABORA_FILE_ROOTS:'[]'},'C:\\fallback'),[]);
  assert.throws(()=>configuredFileRoots({TABORA_FILE_ROOTS:'[C:\\broken]'},''),{message:'invalid_file_roots_config'});
  assert.throws(()=>configuredFileRoots({TABORA_FILE_ROOTS_B64:'malformed!'},''),{message:'invalid_file_roots_config'});
});

test('Windows PowerShell CLI transport preserves actual encoded root arguments',{skip:process.platform!=='win32'},async()=>{
  const f=await fixture();
  try{
    const roots=['C:\\synthetic path\\Ondřej'],json=JSON.stringify(roots),script=path.join(f.dir,'argv.ps1');
    const literal=(value:string)=>"'"+value.replace(/'/g,"''")+"'";
    await writeFile(script,'\ufeff$taboraValue = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('+literal(json)+'))\r\n& '+literal(process.execPath)+' '+literal(path.resolve('tests/fixtures/file-root-argv.mjs'))+' $taboraValue\r\n');
    const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,timeout:15000});
    assert.deepEqual(configuredFileRoots({TABORA_FILE_ROOTS_B64:stdout.trim()},''),roots);
  }finally{await f.close();}
});
test('find/import snapshot is scoped, immutable and hash-verified without a picker',async()=>{
  const f=await fixture();
  try{
    const data=Buffer.from('faktura žluťoučký\n'.repeat(4000)),file=path.join(f.root,'faktura-říjen.txt');await writeFile(file,data);await writeFile(path.join(f.root,'other.txt'),'other');
    const root=f.store.listRoots(f.scope)[0],found=await f.store.find(f.scope,{rootId:root.id,query:'říjen',limit:20,cursor:0});assert.equal(found.files.length,1);
    const meta=await f.store.import(f.scope,{fileRef:found.files[0].fileRef});assert.equal(meta.sha256,createHash('sha256').update(data).digest('hex'));assert(!JSON.stringify(meta).includes(f.root));
    await writeFile(file,'changed by fixture');const {ticket}=f.store.ticket(f.scope,[meta.id]);let offset=0;const chunks:Buffer[]=[];
    while(offset<meta.size){const r=await f.store.readTicket(f.scope.profileId,f.scope.sessionId,ticket,meta.id,offset);chunks.push(Buffer.from(r.data,'base64'));assert(r.nextOffset>offset);offset=r.nextOffset;}
    assert.deepEqual(Buffer.concat(chunks),data);assert.equal(await readFile(file,'utf8'),'changed by fixture');
    await assert.rejects(f.store.readTicket(randomUUID(),f.scope.sessionId,ticket,meta.id,0),{message:'file_ticket_invalid'});
    await assert.rejects(f.store.import({...f.scope,owner:'other'},{fileRef:found.files[0].fileRef}),{message:'file_not_owned'});
    await f.store.release(f.scope,[meta.id]);await assert.rejects(f.store.readTicket(f.scope.profileId,f.scope.sessionId,ticket,meta.id,0),{message:'file_ticket_invalid'});
  }finally{await f.close();}
});
test('exact path import refuses traversal, foreign roots, directories and junction escapes',async()=>{
  const f=await fixture();
  try{
    const outside=path.join(f.dir,'outside');await mkdir(outside);await writeFile(path.join(outside,'secret.txt'),'synthetic');await symlink(outside,path.join(f.root,'escape'),'junction');
    await assert.rejects(f.store.import(f.scope,{path:path.join(outside,'secret.txt')}),{message:'needs_file_access'});
    await assert.rejects(f.store.import(f.scope,{path:path.join(f.root,'..','outside','secret.txt')}),{message:'needs_file_access'});
    await assert.rejects(f.store.import(f.scope,{path:path.join(f.root,'escape','secret.txt')}),{message:'file_path_escape'});
    await assert.rejects(f.store.import(f.scope,{path:f.root}),{message:'needs_file_access'});
    assert.equal(f.store.status(f.scope).files.length,0);
  }finally{await f.close();}
});

test('find continuation counts eligible files and skips oversized sources without repeating matches',async()=>{
  const f=await fixture();
  try{
    const oversized=await open(path.join(f.root,'a-page.txt'),'wx');try{await oversized.truncate(FILE_MAX_BYTES+1);}finally{await oversized.close();}
    await writeFile(path.join(f.root,'b-page.txt'),'one');await writeFile(path.join(f.root,'c-page.txt'),'two');
    const rootId=f.store.listRoots(f.scope)[0].id,first=await f.store.find(f.scope,{rootId,query:'page',limit:1,cursor:0});
    assert.equal(first.files[0].name,'b-page.txt');assert.equal(first.nextCursor,1);
    const second=await f.store.find(f.scope,{rootId,query:'page',limit:1,cursor:first.nextCursor!});
    assert.equal(second.files[0].name,'c-page.txt');assert.equal(second.complete,true);assert.equal(second.nextCursor,null);
  }finally{await f.close();}
});
test('bounded client stream validates offsets, declared length, hash and cross-session access',async()=>{
  const f=await fixture();
  try{
    const data=Buffer.alloc(FILE_CHUNK_BYTES+3,42),transfer=await f.store.begin(f.scope,{name:'agent.bin',size:data.length,mime:'application/octet-stream'});
    await assert.rejects(f.store.chunk(f.scope,{transferId:transfer.transferId,offset:1,data:data.subarray(0,3).toString('base64')}),{message:'invalid_file_chunk'});
    await assert.rejects(f.store.chunk({...f.scope,sessionId:randomUUID()},{transferId:transfer.transferId,offset:0,data:'Kg=='}),{message:'file_not_owned'});
    await f.store.chunk(f.scope,{transferId:transfer.transferId,offset:0,data:data.subarray(0,FILE_CHUNK_BYTES).toString('base64')});
    await assert.rejects(f.store.finish(f.scope,{transferId:transfer.transferId}),{message:'file_transfer_incomplete'});
    await f.store.chunk(f.scope,{transferId:transfer.transferId,offset:FILE_CHUNK_BYTES,data:data.subarray(FILE_CHUNK_BYTES).toString('base64')});
    const meta=await f.store.finish(f.scope,{transferId:transfer.transferId,sha256:createHash('sha256').update(data).digest('hex')});assert.equal(meta.size,data.length);
    assert(!fileChunkSchema.safeParse({transferId:randomUUID(),offset:0,data:Buffer.alloc(FILE_CHUNK_BYTES+1).toString('base64')}).success);
    await assert.rejects(f.store.begin(f.scope,{name:'huge.bin',size:FILE_MAX_BYTES+1,mime:''}),{message:'file_size_limit'});
    const bad=await f.store.begin(f.scope,{name:'bad.txt',size:1,mime:'text/plain'});await f.store.chunk(f.scope,{transferId:bad.transferId,offset:0,data:'YQ=='});
    await assert.rejects(f.store.finish(f.scope,{transferId:bad.transferId,sha256:'0'.repeat(64)}),{message:'file_hash_mismatch'});
    assert(!f.store.status(f.scope).files.some(a=>a.id===bad.transferId));
    f.store.revoke(f.scope);assert.deepEqual(f.store.status(f.scope).files,[]);
  }finally{await f.close();}
});
test('zero-byte file, manual request and revocation do not depend on vault state',async()=>{
  const f=await fixture();
  try{
    const req=f.store.createRequest(f.scope,{purpose:'Příloha',accept:'.txt',multiple:false});assert.equal(f.store.listRequests(f.scope.profileId).length,1);
    const t=await f.store.begin(f.scope,{name:'empty.txt',size:0,mime:'text/plain',requestId:req.requestId}),meta=await f.store.finish(f.scope,{transferId:t.transferId});
    f.store.completeRequest(f.scope,req.requestId,[meta.id]);assert.equal(f.store.listRequests(f.scope.profileId).length,0);
    const ticket=f.store.ticket(f.scope,[meta.id]);assert.equal((await f.store.readTicket(f.scope.profileId,f.scope.sessionId,ticket.ticket,meta.id,0)).eof,true);
    f.store.revokeProfile(f.scope.profileId);await assert.rejects(f.store.readTicket(f.scope.profileId,f.scope.sessionId,ticket.ticket,meta.id,0),{message:'file_ticket_invalid'});
    const req2=f.store.createRequest(f.scope,{purpose:'Příloha',accept:'',multiple:false});
    await f.store.begin(f.scope,{name:'partial.txt',size:10,mime:'text/plain',requestId:req2.requestId});
    await f.store.cancelRequest(f.scope,req2.requestId);assert.equal(f.store.status(f.scope).requests[0].state,'cancelled');assert.deepEqual(f.store.status(f.scope).files,[]);
  }finally{await f.close();}
});

test('startup cleanup deletes only old owned UUID directories and never follows junctions',async()=>{
  const f=await fixture();
  try{
    const base=path.join(f.dir,'artifacts'),old=path.join(base,randomUUID()),outside=path.join(f.dir,'outside');
    await mkdir(old,{recursive:true});await writeFile(path.join(old,'snapshot'),'synthetic');await mkdir(outside);await writeFile(path.join(outside,'keep'),'original');
    await symlink(outside,path.join(base,randomUUID()),'junction');await writeFile(path.join(base,'keep.txt'),'unrelated');
    const transfer=await f.store.begin(f.scope,{name:'current.txt',size:0,mime:'text/plain'});
    await f.store.cleanupPreviousRuns();await assert.rejects(readdir(old),{code:'ENOENT'});
    assert.equal(await readFile(path.join(outside,'keep'),'utf8'),'original');assert.equal(await readFile(path.join(base,'keep.txt'),'utf8'),'unrelated');
    assert.equal((await f.store.finish(f.scope,{transferId:transfer.transferId})).size,0);
  }finally{await f.close();}
});
test('router isolates uploaded artifacts and blocks readonly dispatch',async()=>{
  const f=await fixture(),router=new BrokerRouter(undefined,f.store),profile={id:f.scope.profileId,name:'fixture',mcpEnabled:true,mode:'safe' as const,vaultEnabled:false};
  const calls:any[]=[];router.register({profile,call:async(command,payload:any)=>{calls.push({command,payload});return {id:payload.id,ok:true};}});
  try{
    const session=await router.call('agent','browser_session_create',{profileId:profile.id,name:'upload'});
    const transfer=await router.call('agent','browser_files_begin',{sessionId:session.id,name:'file.txt',size:0,mime:'text/plain'});
    const meta=await router.call('agent','browser_files_finish',{sessionId:session.id,transferId:transfer.transferId});
    await assert.rejects(router.call('other','browser_upload',{sessionId:session.id,targetId:'e0',stateVersion:'doc:token',artifactIds:[meta.id]}),{message:'session_not_owned'});
    await router.call('agent','browser_upload',{sessionId:session.id,targetId:'e0',stateVersion:'doc:token',artifactIds:[meta.id]});assert.equal(calls.at(-1).command,'files.upload');assert(!JSON.stringify(calls.at(-1).payload).includes(f.root));
    router.update({...profile,mode:'readonly'});await assert.rejects(router.call('agent','browser_upload',{sessionId:session.id,targetId:'e0',stateVersion:'doc:token',artifactIds:[meta.id]}),{message:'readonly_mode'});
  }finally{await f.close();}
});

test('explicit artifact chunks preserve bytes and remain scoped after revocation',async()=>{
  const f=await fixture();try{
    const bytes=Buffer.from('000123\n'+ 'x'.repeat(40000)),transfer=await f.store.begin(f.scope,{name:'report.csv',size:bytes.length,mime:'text/csv'});
    for(let offset=0;offset<bytes.length;offset+=32768)await f.store.chunk(f.scope,{transferId:transfer.transferId,offset,data:bytes.subarray(offset,offset+32768).toString('base64')});
    const meta=await f.store.finish(f.scope,{transferId:transfer.transferId});
    const first=await f.store.readOwned(f.scope,meta.id,0),second=await f.store.readOwned(f.scope,meta.id,first.nextOffset);
    assert.equal(first.eof,false);assert.equal(second.eof,true);assert.deepEqual(Buffer.concat([Buffer.from(first.data,'base64'),Buffer.from(second.data,'base64')]),bytes);
    await assert.rejects(f.store.readOwned({...f.scope,sessionId:randomUUID()},meta.id,0),{message:'file_not_owned'});
    f.store.revoke(f.scope);await assert.rejects(f.store.readOwned(f.scope,meta.id,0),{message:'file_not_owned'});
  }finally{await f.close();}
});

test('workflow discovery imports only one exact filename inside existing roots',async()=>{
  const f=await fixture();class ActiveRuns extends RunController{override active(){return true;}}
  const router=new BrokerRouter(new ActiveRuns(),f.store);
  try{
    await writeFile(path.join(f.root,'contract.txt'),'Synthetic contract');
    const artifact=await router.workflowCall(f.scope,async()=>{throw Error('No browser or model call allowed');},'workflow.file',{name:'contract.txt'});
    assert.equal(artifact.name,'contract.txt');assert.equal(artifact.sha256,createHash('sha256').update('Synthetic contract').digest('hex'));
    await assert.rejects(router.workflowCall(f.scope,async()=>{},'workflow.file',{name:'contract.txt',rootId:randomUUID()}),{message:'needs_file_access'});
    await mkdir(path.join(f.root,'duplicate'));await writeFile(path.join(f.root,'duplicate','contract.txt'),'Different contract');
    await assert.rejects(router.workflowCall(f.scope,async()=>{},'workflow.file',{name:'contract.txt'}),{message:'ambiguous_file'});
    await assert.rejects(router.workflowCall(f.scope,async()=>{},'workflow.file',{path:path.join(f.dir,'private.txt')}),{message:'needs_file_access'});
  }finally{await f.close();}
});
