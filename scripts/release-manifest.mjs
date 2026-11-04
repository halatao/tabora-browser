import path from 'node:path';
import {readFile,writeFile,lstat} from 'node:fs/promises';
import {sign,createPrivateKey,createPublicKey,verify} from 'node:crypto';
import {hashFile,repository} from './distribution/release.mjs';
const root=path.resolve(import.meta.dirname,'..'),directory=path.resolve(process.argv[2]??path.join(root,'release'));
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')),trust=JSON.parse(await readFile(path.join(directory,'payload/release-trust.json'),'utf8'));
const sequence=Number(process.env.TABORA_RELEASE_SEQUENCE);if(!Number.isSafeInteger(sequence)||sequence<1)throw new Error('TABORA_RELEASE_SEQUENCE is required.');
const channel=process.env.TABORA_RELEASE_CHANNEL??'stable';if(!['stable','preview'].includes(channel))throw new Error('Invalid release channel.');
const releaseId=(channel==='preview'?'preview-v':'v')+pkg.version;
const key=createPrivateKey(process.env.TABORA_RELEASE_PRIVATE_KEY??'');if(key.asymmetricKeyType!=='ed25519')throw new Error('An Ed25519 release signing key is required.');
const artifacts=[];
for(const [suffix,kind] of [['windows-x64.zip','payload'],['extension.zip','extension'],['chrome-store.zip','extension'],['windows-x64-setup.exe','installer']]){
  const name=`tabora-${pkg.version}-${suffix}`,file=path.join(directory,name);let info;
  try{info=await lstat(file);}catch(error){if(error.code==='ENOENT'&&kind==='installer'&&channel==='preview')continue;throw error;}
  artifacts.push({name,kind,size:info.size,sha256:await hashFile(file),url:`${repository}/releases/download/${releaseId}/${name}`});
}
const descriptor=JSON.parse(await readFile(path.join(directory,'payload/package-info.json'),'utf8'));if(descriptor.channel!==channel)throw new Error('Payload/release channel mismatch.');
const manifest={schema:1,version:pkg.version,releaseId,sequence,channel,platform:'win32',arch:'x64',minUpdater:1,contractVersion:2,extensionId:(await readFile(path.join(directory,'payload/extension-id.txt'),'utf8')).trim(),issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+90*86400000).toISOString(),artifacts};
const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n'),signature=sign(null,bytes,key);
if(!trust.keys.some(item=>verify(null,bytes,createPublicKey(item.publicKey),signature)))throw new Error('The signing key is not trusted by the packaged updater.');
await writeFile(path.join(directory,'release-manifest.json'),bytes);await writeFile(path.join(directory,'release-manifest.sig'),signature);
await writeFile(path.join(directory,'SHA256SUMS'),artifacts.map(item=>`${item.sha256}  ${item.name}\n`).join(''));
console.log('Release manifest signed.');
