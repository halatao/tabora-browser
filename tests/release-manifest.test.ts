import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {generateKeyPairSync,verify,createPublicKey} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

test('preview may publish signed ZIPs while stable still requires its installer',async()=>{
  const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'release-manifest-'));
  const pair=generateKeyPairSync('ed25519'),publicKey=pair.publicKey.export({type:'spki',format:'pem'}),privateKey=pair.privateKey.export({type:'pkcs8',format:'pem'});
  const pkg=JSON.parse(await readFile('package.json','utf8'));
  try{
    await mkdir(path.join(directory,'payload'));
    await writeFile(path.join(directory,'payload/release-trust.json'),JSON.stringify({schema:1,keys:[{publicKey}]}));
    await writeFile(path.join(directory,'payload/extension-id.txt'),'a'.repeat(32));
    for(const suffix of ['windows-x64.zip','extension.zip','chrome-store.zip'])await writeFile(path.join(directory,`tabora-${pkg.version}-${suffix}`),'fixture');
    await writeFile(path.join(directory,'payload/package-info.json'),JSON.stringify({channel:'preview'}));
    const run=promisify(execFile),env={...process.env,TABORA_RELEASE_PRIVATE_KEY:String(privateKey),TABORA_RELEASE_SEQUENCE:'1',TABORA_RELEASE_CHANNEL:'preview'};
    await run(process.execPath,['scripts/release-manifest.mjs',directory],{env,windowsHide:true});
    const bytes=await readFile(path.join(directory,'release-manifest.json')),signature=await readFile(path.join(directory,'release-manifest.sig'));
    assert(verify(null,bytes,createPublicKey(publicKey),signature));
    const manifest=JSON.parse(bytes.toString());assert.equal(manifest.channel,'preview');assert.deepEqual(manifest.artifacts.map((item:any)=>item.kind),['payload','extension','extension']);
    await writeFile(path.join(directory,'payload/package-info.json'),JSON.stringify({channel:'stable'}));
    await assert.rejects(run(process.execPath,['scripts/release-manifest.mjs',directory],{env:{...env,TABORA_RELEASE_CHANNEL:'stable'},windowsHide:true}),/ENOENT/);
  }finally{assert(directory.startsWith(base+path.sep));await rm(directory,{recursive:true,force:true});}
});
