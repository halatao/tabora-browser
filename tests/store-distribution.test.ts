import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,mkdtemp,writeFile,readFile,rm,lstat} from 'node:fs/promises';
import {publicKeyId,extensionIdentities,nativeExtensionChannel,compatibleExtension} from '../scripts/distribution/extension-identity.mjs';
import {packageStoreExtension} from '../scripts/distribution/extension-package.mjs';
import {switchExtensionChannel,recoverExtensionChannel} from '../scripts/distribution/extension-channel.mjs';
import {extract} from '../scripts/distribution/archive.mjs';
import {atomicJson,json} from '../scripts/distribution/files.mjs';
import {hashFile} from '../scripts/distribution/release.mjs';

const identities={schema:1 as const,unpacked:'a'.repeat(32),store:'b'.repeat(32)};
async function fixture(){
  const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'store-distribution-'));
  const root=path.join(directory,'app'),state=path.join(directory,'state'),version=path.join(root,'versions/0.6.3-'+'c'.repeat(16));
  const config={schema:1,product:'tabora-browser',id:'10000000-0000-4000-8000-000000000001',current:'0.6.3-'+'c'.repeat(16),stateDir:state,requestedStateDir:state,extensionId:identities.unpacked,installKind:'unpacked',channel:'preview',policy:'notify',sequence:4};
  const entries:Record<string,string>={'tabora.exe':'fixture','runtime/node.exe':'fixture','dist/host/main.js':'fixture','dist/host/mcp.js':'fixture','dist/host/update-worker.js':'fixture','dist/extension/manifest.json':JSON.stringify({manifest_version:3,key:'fixture',permissions:['debugger'],version:'0.6.3'}),'dist/extension/icon.png':'synthetic-image','scripts/cli.mjs':'fixture','release-trust.json':'{"schema":1,"keys":[]}', 'extension-id.txt':identities.unpacked,'extension-identities.json':JSON.stringify(identities),'dist/build-info.json':JSON.stringify({version:'0.6.3',fingerprint:'c'.repeat(64),contractVersion:2})};
  const inventory:Record<string,string>={};
  for(const [relative,bytes] of Object.entries(entries)){const file=path.join(version,relative);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);inventory[relative]=await hashFile(file);}
  await atomicJson(path.join(version,'package-info.json'),{schema:1,platform:process.platform,arch:process.arch,versionId:config.current,channel:'preview',inventory});
  await atomicJson(path.join(root,'installation.json'),config);await mkdir(path.join(root,'extension-unpacked'));await writeFile(path.join(root,'extension-unpacked/retained.txt'),'legacy-preferences-marker');
  await mkdir(state);await writeFile(path.join(state,'vault.json'),'opaque-encrypted-fixture');
  return {directory,root,state,version,config,close:()=>{assert.equal(path.dirname(directory),base);return rm(directory,{recursive:true,force:true});}};
}
test('Store key derives the registered ID; native access is exact and opt-in',async()=>{
  const published=JSON.parse(await readFile('extension-identities.json','utf8'));
  assert.equal(publicKeyId(await readFile('docs/publishing/chrome-store-public-key.pem','utf8')),published.store);
  const origin=`chrome-extension://${identities.store}/`;
  assert.throws(()=>nativeExtensionChannel(origin,identities),/unrecognized/);
  assert.equal(nativeExtensionChannel(origin,identities,'store'),'store');
  assert.equal(nativeExtensionChannel(`chrome-extension://${identities.unpacked}/`,identities,'store'),'unpacked');
  for(const wrong of [origin+'x',origin.slice(0,-1),origin.toUpperCase(),'chrome-extension://'+'d'.repeat(32)+'/','https://'+identities.store+'/'])assert.throws(()=>nativeExtensionChannel(wrong,identities,'store'));
  const build={contractVersion:2,fingerprint:'c'.repeat(64)};
  assert(compatibleExtension({contractVersion:2,extensionChannel:'store',fingerprint:'old'},build));
  assert(!compatibleExtension({contractVersion:1,extensionChannel:'store'},build));
  assert(!compatibleExtension({contractVersion:2,extensionChannel:'store',managedProfile:'fixture',fingerprint:'old'},build));
  assert(!compatibleExtension({contractVersion:2,fingerprint:'old'},build));
});
test('identity metadata fails closed and old payloads retain unpacked-only access',async()=>{
  const f=await fixture();try{
    await rm(path.join(f.version,'extension-identities.json'));
    assert.deepEqual(await extensionIdentities(f.version),{schema:1,unpacked:identities.unpacked});
    await assert.rejects(async()=>nativeExtensionChannel(`chrome-extension://${identities.store}/`,await extensionIdentities(f.version),'store'),/store_identity_unavailable/);
    for(const changed of [{...identities,unpacked:'d'.repeat(32)},{...identities,store:'*'},{...identities,extra:'d'.repeat(32)}]){await atomicJson(path.join(f.version,'extension-identities.json'),changed);await assert.rejects(extensionIdentities(f.version),/invalid_extension_identities/);}
  }finally{await f.close();}
});
test('Store ZIP preserves every source file and manifest field except the unpacked key',async()=>{
  const f=await fixture();try{
    const source=path.join(f.version,'dist/extension'),archive=path.join(f.directory,'store.zip');
    const before=await readFile(path.join(source,'manifest.json'),'utf8');
    await packageStoreExtension(source,path.join(f.directory,'staging'),archive);
    const output=path.join(f.directory,'extracted');await extract(archive,output);
    const expected=JSON.parse(before);delete expected.key;
    assert.deepEqual(await json(path.join(output,'manifest.json')),expected);
    assert.equal(await readFile(path.join(source,'manifest.json'),'utf8'),before);
    assert.equal(await readFile(path.join(output,'icon.png'),'utf8'),'synthetic-image');
    const second=path.join(f.directory,'second.zip');await packageStoreExtension(source,path.join(f.directory,'staging-second'),second);
    assert.equal(await hashFile(archive),await hashFile(second));
  }finally{await f.close();}
});
test('explicit channel transition retains data and legacy files, serializes with updates and rolls back errors',async()=>{
  const f=await fixture();try{
    let registrations=0;const options={registration:async()=>{registrations++;},isIdle:()=>true};
    await assert.rejects(switchExtensionChannel(f.root,'store',{...options,isIdle:()=>false}),/requires_idle/);
    assert.equal((await json(path.join(f.root,'installation.json'))).installKind,'unpacked');
    const lock=path.join(f.root,'update.lock');await mkdir(lock);
    await assert.rejects(switchExtensionChannel(f.root,'store',options),/update_already_applying/);await rm(lock,{recursive:true});
    const result=await switchExtensionChannel(f.root,'store',options);
    assert.equal(result.extensionId,identities.store);assert.equal(result.profilePermissionsTransferred,false);
    assert.deepEqual(await json(path.join(f.root,'installation.json')),{...f.config,installKind:'store'});
    assert.equal(await readFile(path.join(f.state,'vault.json'),'utf8'),'opaque-encrypted-fixture');
    assert.equal(await readFile(path.join(f.root,'extension-unpacked/retained.txt'),'utf8'),'legacy-preferences-marker');
    assert.equal((await switchExtensionChannel(f.root,'store',options)).changed,false);assert.equal(registrations,1);
    await switchExtensionChannel(f.root,'unpacked',options);assert.deepEqual(await json(path.join(f.root,'installation.json')),f.config);
    let calls=0;
    await assert.rejects(switchExtensionChannel(f.root,'store',{...options,registration:async()=>{if(++calls===1)throw new Error('synthetic_registration_failure');}}),/synthetic_registration_failure/);
    assert.equal(calls,2);assert.deepEqual(await json(path.join(f.root,'installation.json')),f.config);await assert.rejects(lstat(lock));
  }finally{await f.close();}
});
test('interrupted channel registration can be repaired, but a live owner cannot be stolen',async t=>{
  const f=await fixture();try{
    const lock=path.join(f.root,'update.lock');await mkdir(lock);await atomicJson(path.join(lock,'owner.json'),{kind:'extension-channel',installationId:f.config.id,pid:process.pid});
    await assert.rejects(recoverExtensionChannel(f.root,{registration(){}}),/updater_still_running/);
    t.mock.method(process,'kill',()=>{throw Object.assign(new Error('fixture gone'),{code:'ESRCH'});});
    let repaired=false;assert(await recoverExtensionChannel(f.root,{registration(){repaired=true;}}));assert(repaired);await assert.rejects(lstat(lock));
  }finally{await f.close();}
});
test('a Store-only installation can return to unpacked without changing data identity',async()=>{
  const f=await fixture();try{
    await atomicJson(path.join(f.root,'installation.json'),{...f.config,installKind:'store'});
    const extension=path.join(f.root,'extension-unpacked');assert.equal(path.dirname(extension),f.root);await rm(extension,{recursive:true});
    await switchExtensionChannel(f.root,'unpacked',{registration(){},isIdle:()=>true});
    assert.equal((await json(path.join(extension,'manifest.json'))).version,'0.6.3');
    assert.deepEqual(await json(path.join(f.root,'installation.json')),f.config);
    assert.equal(await readFile(path.join(f.state,'vault.json'),'utf8'),'opaque-encrypted-fixture');
  }finally{await f.close();}
});
