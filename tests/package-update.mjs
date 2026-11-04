import path from 'node:path';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,cp,readFile,writeFile,rm,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {install,installation} from '../scripts/distribution/installation.mjs';
import {files,atomicJson,json} from '../scripts/distribution/files.mjs';
import {hashFile} from '../scripts/distribution/release.mjs';
const exec=promisify(execFile),payload=path.resolve(process.argv[2]??'release/payload'),base=path.resolve('.test-state');
const store=process.argv.includes('--store');
await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'package-update-'));
const root=path.join(directory,'app'),state=path.join(directory,'state'),target=path.join(directory,'next-payload');
try{
  const old=await install(payload,root,{stateDir:state,registration(){},...(store?{extensionChannel:'store'}:{})});
  if(store)await cp(path.join(payload,'dist/extension'),path.join(root,'extension-unpacked'),{recursive:true,errorOnExist:true,force:false});
  const oldBuild=await json(path.join(payload,'dist/build-info.json'));const parts=oldBuild.version.split('.').map(Number);parts[2]++;
  const next={...oldBuild,version:parts.join('.'),fingerprint:createHash('sha256').update(oldBuild.fingerprint+'-synthetic-update-fixture').digest('hex')};
  await cp(payload,target,{recursive:true});const changed=[];
  // A synthetic release changes only embedded build identity, not any model or website logic.
  for(const relative of (await files(path.join(target,'dist'))).filter(file=>file.endsWith('.js'))){
    const file=path.join(target,'dist',relative),text=await readFile(file,'utf8');
    if(text.includes(oldBuild.fingerprint)){await writeFile(file,text.replaceAll(oldBuild.fingerprint,next.fingerprint).replaceAll(`version: "${oldBuild.version}"`,`version: "${next.version}"`));changed.push('dist/'+relative);}
  }
  assert(changed.some(file=>file==='dist/host/broker.js'));assert(changed.some(file=>file==='dist/extension/background.js'));
  await atomicJson(path.join(target,'dist/build-info.json'),next);changed.push('dist/build-info.json');
  for(const relative of ['package.json','package-lock.json','dist/extension/manifest.json']){const value=await json(path.join(target,relative));value.version=next.version;if(value.packages)value.packages[''].version=next.version;await atomicJson(path.join(target,relative),value);changed.push(relative);}
  const descriptor=await json(path.join(target,'package-info.json'),16_000_000);descriptor.versionId=next.version+'-'+next.fingerprint.slice(0,16);
  for(const relative of changed)descriptor.inventory[relative]=await hashFile(path.join(target,relative));await atomicJson(path.join(target,'package-info.json'),descriptor);
  const result=await install(target,root,{registration(){}});assert.equal(result.status,'scheduled');
  const job=path.join(state,'updates',result.updateId,'journal.json'),deadline=Date.now()+240000;let status;
  for(;;){status=await json(job);if(['mcp_restart_required','rolled_back','recovery_required'].includes(status.status))break;if(Date.now()>deadline)throw new Error('Update deadline: '+JSON.stringify({status:status.status,checkpoint:status.checkpoint,code:status.code}));await new Promise(resolve=>setTimeout(resolve,500));}
  assert.equal(status.status,'mcp_restart_required',JSON.stringify(status));
  const current=await installation(root);assert.equal(current.config.current,descriptor.versionId);assert.equal(current.config.previous,old.config.current);assert.equal(current.config.stateDir,old.config.stateDir);assert.equal(current.config.installKind,store?'store':'unpacked');
  assert.equal((await json(path.join(root,'extension-unpacked/manifest.json'))).version,next.version);
  const reported=JSON.parse((await exec(path.join(root,'tabora.exe'),['version'],{windowsHide:true})).stdout);assert.equal(reported.fingerprint,next.fingerprint);
  const doctor=JSON.parse((await exec(path.join(root,'tabora.exe'),['doctor'],{windowsHide:true,timeout:120000})).stdout);assert(doctor.mcp);assert.equal(doctor.profileConnected,false);assert.equal(status.extensionVerified,false,'no connected profile is not a verified extension');
  assert.equal((await lstat(path.join(root,'versions',old.config.current))).isDirectory(),true);await assert.rejects(lstat(path.join(root,'update.lock')));
  console.log('PASS: real packaged updater stages an offline synthetic release, switches immutable versions and stable extension files, shuts down/restarts the real broker, verifies the new host and retains rollback/data identity. Offline browser verification remains explicitly pending. No user registry/profile changed.');
}finally{
  await new Promise(resolve=>setTimeout(resolve,3500));assert(directory.startsWith(base+path.sep));
  if(process.env.TABORA_KEEP_PACKAGE_TEST_STATE==='1')console.log('Retained update fixture: '+directory);else await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:300});
}
