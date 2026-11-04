import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,mkdtemp,writeFile,readFile,rm,lstat} from 'node:fs/promises';
import {generateKeyPairSync,sign} from 'node:crypto';
import {MaintenanceGate,InstallationUpdates} from '../src/host/installation-updates.js';
import {releaseManifest,download} from '../scripts/distribution/release.mjs';
import {confined} from '../scripts/distribution/files.mjs';
import {atomicJson} from '../scripts/distribution/files.mjs';
import {cleanupInstallation} from '../scripts/distribution/cleanup.mjs';
import {hashFile} from '../scripts/distribution/release.mjs';
// @ts-expect-error Archive creation is a build-only JavaScript export.
import {zip,extract} from '../scripts/distribution/archive.mjs';

const {publicKey,privateKey}=generateKeyPairSync('ed25519');
const trust={keys:[{publicKey:publicKey.export({type:'spki',format:'pem'})}]};
function release(overrides={}){return {schema:1,version:'0.6.0',releaseId:'v0.6.0',sequence:2,channel:'stable',platform:'win32',arch:process.arch,minUpdater:1,contractVersion:2,extensionId:'a'.repeat(32),issuedAt:new Date(Date.now()-10000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),artifacts:[{kind:'payload',name:'payload.zip',size:100,sha256:'a'.repeat(64),url:'https://github.com/halatao/tabora-browser/releases/download/v0.6.0/payload.zip'}],...overrides};}
function signed(value:unknown){const bytes=Buffer.from(JSON.stringify(value));return {bytes,signature:sign(null,bytes,privateKey)};}
test('only trusted, current, compatible, strictly scoped signed releases can install',()=>{
  const good=signed(release());assert.equal(releaseManifest(good.bytes,good.signature,trust,{version:'0.5.6',sequence:1}).version,'0.6.0');
  assert.throws(()=>releaseManifest(good.bytes,good.signature,{keys:[]}));
  assert.throws(()=>releaseManifest(Buffer.concat([good.bytes,Buffer.from(' ')]),good.signature,trust));
  for(const value of [release({sequence:1}),release({expiresAt:new Date(0).toISOString()}),release({contractVersion:3}),release({platform:'linux'}),release({arch:'unknown'}),release({artifacts:[{...release().artifacts[0],url:'https://evil.test/payload.zip'}]})]){
    const candidate=signed(value);assert.throws(()=>releaseManifest(candidate.bytes,candidate.signature,trust,{version:'0.5.6',sequence:1}));
  }
});
test('a valid preview signature requires explicit preview authorization',()=>{
  const manifest=release({channel:'preview',releaseId:'preview-v0.6.0',artifacts:[{...release().artifacts[0],url:'https://github.com/halatao/tabora-browser/releases/download/preview-v0.6.0/payload.zip'}]});
  const candidate=signed(manifest);assert.throws(()=>releaseManifest(candidate.bytes,candidate.signature,trust));
  assert.equal(releaseManifest(candidate.bytes,candidate.signature,trust,{channel:'preview'}).channel,'preview');
});
test('download rejects foreign redirects, oversized streaming bodies and wrong hashes',async()=>{
  await assert.rejects(download('https://evil.test/file'),/origin/);
  await assert.rejects(download('https://github.com/asset',undefined,{request:async()=>new Response(null,{status:302,headers:{location:'https://evil.test/asset'}})}),/origin/);
  await assert.rejects(download('https://github.com/asset',undefined,{maximum:3,request:async()=>new Response('1234')}),/limit/);
  await assert.rejects(download('https://github.com/asset',undefined,{sha256:'0'.repeat(64),request:async()=>new Response('1234')}),/integrity/);
  assert.equal((await download('https://github.com/asset',undefined,{request:async()=>new Response('ok')})).toString(),'ok');
});

test('large package downloads get a bounded longer deadline and share it across redirects',async t=>{
  const deadlines:number[]=[],signal=new AbortController().signal;t.mock.method(AbortSignal,'timeout',(milliseconds:number)=>{deadlines.push(milliseconds);return signal;});
  const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'download-deadline-'));
  try{
    await download('https://github.com/manifest',undefined,{request:async()=>new Response('metadata')});
    const seen:AbortSignal[]= [];let requests=0;
    await download('https://github.com/payload.zip',path.join(directory,'payload.zip'),{maximum:400_000_000,size:7,request:async(_url,options)=>{seen.push(options!.signal!);return ++requests===1?new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/payload'}}):new Response('payload');}});
    assert(deadlines[0]!<=120000);assert(deadlines[1]!>=10*60*1000&&deadlines[1]!<=15*60*1000);assert.equal(seen[0],seen[1]);
    assert.equal(await readFile(path.join(directory,'payload.zip'),'utf8'),'payload');
    await assert.rejects(download('https://github.com/slow',undefined,{request:async()=>{throw new DOMException('deadline','TimeoutError');}}),/update_download_timeout/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('maintenance closes admission atomically, drains existing work and binds resume to its owner',async()=>{
  const gate=new MaintenanceGate();let finish!:()=>void;
  const work=gate.run(()=>new Promise<void>(resolve=>{finish=resolve;}));const id='10000000-0000-4000-8000-000000000001';
  assert.equal(gate.begin(id),false);await assert.rejects(gate.run(async()=>{}),/update_maintenance/);assert.throws(()=>gate.resume('other'));
  finish();await work;assert(gate.idle);gate.resume(id);await gate.run(async()=>{});
});
test('source installations never silently install remote code',async()=>{
  const service=new InstallationUpdates('');assert.equal((await service.check()).installKind,'source');await assert.rejects(service.prepare(),/source_installation/);
});
test('package paths reject Windows aliases, traversal and device paths',()=>{
  for(const relative of ['../secret','/absolute','C:/file','a\\b','file:stream','con.txt','a/../b','a./b','x /b','a//b','\\\\server\\share'])assert.throws(()=>confined(path.resolve('.test-state'),relative));
  assert(confined(path.resolve('.test-state'),'safe/žluťoučký.txt').endsWith('žluťoučký.txt'));
});
test('ZIP roundtrip rejects mutation, duplicate names and traversal before writing outside staging',async()=>{
  const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'distribution-test-'));
  try{
    const input=path.join(directory,'input');await mkdir(input);await writeFile(path.join(input,'safe.txt'),'hello');
    const archive=path.join(directory,'payload.zip');await zip(input,archive);const output=path.join(directory,'output');await extract(archive,output);assert.equal(await readFile(path.join(output,'safe.txt'),'utf8'),'hello');
    const bytes=await readFile(archive);const changed=Buffer.from(bytes);changed[changed.indexOf(Buffer.from('safe.txt'))]='.' .charCodeAt(0);await writeFile(path.join(directory,'changed.zip'),changed);
    await assert.rejects(extract(path.join(directory,'changed.zip'),path.join(directory,'changed')));
    const traversal=Buffer.from(bytes);for(let offset=traversal.indexOf('safe.txt');offset>=0;offset=traversal.indexOf('safe.txt',offset+8))Buffer.from('../x.txt').copy(traversal,offset);
    await writeFile(path.join(directory,'traversal.zip'),traversal);await assert.rejects(extract(path.join(directory,'traversal.zip'),path.join(directory,'traversal')),/path/);
    await writeFile(path.join(input,'more.txt'),'other');const duplicateArchive=path.join(directory,'duplicates.zip');await zip(input,duplicateArchive);
    const duplicates=await readFile(duplicateArchive);for(let offset=duplicates.indexOf('more.txt');offset>=0;offset=duplicates.indexOf('more.txt',offset+8))Buffer.from('safe.txt').copy(duplicates,offset);
    await writeFile(duplicateArchive,duplicates);await assert.rejects(extract(duplicateArchive,path.join(directory,'duplicates')),/name_collision/);
  }finally{assert(directory.startsWith(base+path.sep));await rm(directory,{recursive:true,force:true});}
});
for(const channel of ['stable','preview'] as const)test(`${channel} staging verifies signed metadata, inventory and durable tickets`,async()=>{
  const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'update-stage-'));
  try{
    const root=path.join(directory,'app'),state=path.join(directory,'state'),old=path.join(root,'versions/0.5.6-'+ 'b'.repeat(16)),payload=path.join(directory,'payload');
    await mkdir(path.join(old,'dist'),{recursive:true});await mkdir(payload);
    await atomicJson(path.join(root,'installation.json'),{schema:1,product:'tabora-browser',id:'10000000-0000-4000-8000-000000000001',current:'0.5.6-'+ 'b'.repeat(16),stateDir:state,requestedStateDir:state,extensionId:'a'.repeat(32),installKind:'unpacked',channel,policy:'notify',sequence:1});
    await atomicJson(path.join(old,'dist/build-info.json'),{version:'0.5.6',fingerprint:'b'.repeat(64),contractVersion:2});await atomicJson(path.join(old,'release-trust.json'),trust);
    const entries={'tabora.exe':'fixture','runtime/node.exe':'fixture','dist/host/main.js':'fixture','dist/host/mcp.js':'fixture','dist/host/update-worker.js':'fixture','dist/extension/manifest.json':'{}','scripts/cli.mjs':'fixture','release-trust.json':JSON.stringify(trust),'extension-id.txt':'a'.repeat(32),'dist/build-info.json':JSON.stringify({version:'0.6.0',fingerprint:'c'.repeat(64),contractVersion:2})};
    const inventory:Record<string,string>={};
    for(const [file,bytes] of Object.entries(entries)){await mkdir(path.dirname(path.join(payload,file)),{recursive:true});await writeFile(path.join(payload,file),bytes);inventory[file]=await hashFile(path.join(payload,file));}
    await atomicJson(path.join(payload,'package-info.json'),{schema:1,platform:process.platform,arch:process.arch,channel,versionId:'0.6.0-'+ 'c'.repeat(16),inventory});
    const archive=path.join(directory,'payload.zip');await zip(payload,archive);const zipBytes=await readFile(archive);
    const tag=(channel==='preview'?'preview-v':'v')+'0.6.0';
    const manifest=release({source:'local-installer',channel,releaseId:tag,artifacts:[{...release().artifacts[0],url:`https://github.com/halatao/tabora-browser/releases/download/${tag}/payload.zip`,size:zipBytes.length,sha256:await hashFile(archive)}]});const signedManifest=signed(manifest);
    const request:typeof fetch=async url=>String(url).startsWith('https://api.github.com/')?Response.json([{tag_name:tag,draft:false,prerelease:channel==='preview'}]):new Response(String(url).endsWith('.sig')?signedManifest.signature:String(url).endsWith('.json')?signedManifest.bytes:zipBytes);
    const service=new InstallationUpdates(root,request),job=await service.prepare();let status:any;
    for(let i=0;i<200;i++){status=await service.status(job.updateId);if(status.status!=='downloading')break;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(status.status,'staged',JSON.stringify(status));assert.equal(status.latestVersion,'0.6.0');assert(!JSON.stringify(status).includes(job.ticket));assert(!JSON.stringify(status).includes('ticketHash'));
    await assert.rejects(service.apply(job.updateId,'20000000-0000-4000-8000-000000000002'),/invalid_update_ticket/);
    assert.equal((await new InstallationUpdates(root,request).status(job.updateId)).status,'staged');
    const journal=path.join(state,'updates',job.updateId,'journal.json'),staged=JSON.parse(await readFile(journal,'utf8'));
    const initial=JSON.parse(await readFile(path.join(root,'installation.json'),'utf8'));
    await atomicJson(path.join(root,'installation.json'),{...initial,channel:'stable'});
    await atomicJson(journal,{...staged,manifest:{...staged.manifest,channel:'preview'}});await assert.rejects(service.apply(job.updateId,job.ticket),/release_channel_changed/);await atomicJson(journal,staged);await atomicJson(path.join(root,'installation.json'),initial);
    const configuration=JSON.parse(await readFile(path.join(root,'installation.json'),'utf8')),newId='0.5.7-'+ 'd'.repeat(16);
    await atomicJson(path.join(root,'versions',newId,'dist/build-info.json'),{version:'0.5.7',fingerprint:'d'.repeat(64),contractVersion:2});
    await atomicJson(path.join(root,'versions',newId,'release-trust.json'),trust);
    await atomicJson(path.join(root,'installation.json'),{...configuration,current:newId,sequence:2});
    await assert.rejects(service.apply(job.updateId,job.ticket),/release_replay_or_downgrade/,'revalidate after another installation advances; remote metadata cannot impersonate a local installer');
    await atomicJson(path.join(root,'installation.json'),{...configuration,current:newId,sequence:2,policy:'off'});
    assert.equal((await service.check()).remoteInstallationAvailable,false);await assert.rejects(service.prepare(),/update_checks_disabled/);await assert.rejects(service.apply(job.updateId,job.ticket),/update_checks_disabled/);
  }finally{assert(directory.startsWith(base+path.sep));await rm(directory,{recursive:true,force:true});}
});
test('cleanup retains current, rollback and live versions and removes only owned terminal staging',async()=>{
  const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'update-cleanup-'));
  try{
    const root=path.join(directory,'app'),state=path.join(directory,'state'),installationId='10000000-0000-4000-8000-000000000001';
    const names=['0.6.0-','0.5.9-','0.5.8-','0.5.7-'].map(name=>name+'a'.repeat(16));
    await atomicJson(path.join(root,'installation.json'),{id:installationId,current:names[0],previous:names[1]});
    for(const name of names)await atomicJson(path.join(root,'versions',name,'package-info.json'),{schema:1,versionId:name});
    const job='20000000-0000-4000-8000-000000000002',jobDirectory=path.join(state,'updates',job);
    await atomicJson(path.join(jobDirectory,'journal.json'),{id:job,installationId,status:'mcp_restart_required'});await mkdir(path.join(jobDirectory,'payload'));await writeFile(path.join(jobDirectory,'payload.zip'),'fixture');
    await cleanupInstallation(root,state,installationId,job,async directory=>directory.endsWith(names[2]));
    for(const name of names.slice(0,3))assert((await lstat(path.join(root,'versions',name))).isDirectory());
    await assert.rejects(lstat(path.join(root,'versions',names[3])));await assert.rejects(lstat(path.join(jobDirectory,'payload')));await assert.rejects(lstat(path.join(jobDirectory,'payload.zip')));assert((await lstat(path.join(jobDirectory,'journal.json'))).isFile());
  }finally{assert(directory.startsWith(base+path.sep));await rm(directory,{recursive:true,force:true});}
});
