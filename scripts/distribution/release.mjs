import {createHash, createPublicKey, verify} from 'node:crypto';
import {open} from 'node:fs/promises';

export const repository='https://github.com/halatao/tabora-browser';
const versionPattern=/^\d+\.\d+\.\d+$/;
export function compare(a,b) {
  if(!versionPattern.test(a)||!versionPattern.test(b))throw new Error('invalid_release_version');
  for(let i=0;i<3;i++){const difference=Number(a.split('.')[i])-Number(b.split('.')[i]);if(difference)return Math.sign(difference);}return 0;
}
export function releaseManifest(bytes,signature,trust,{now=Date.now(),sequence=0,version='0.0.0',contract=2,arch=process.arch,channel='stable'}={}) {
  if(bytes.length>65536||signature.length>256)throw new Error('release_metadata_limit');
  if(!Array.isArray(trust.keys)||!trust.keys.length)throw new Error('release_trust_not_configured');
  const signed=trust.keys.some(key=>{try{const publicKey=createPublicKey(key.publicKey);return publicKey.asymmetricKeyType==='ed25519'&&verify(null,bytes,publicKey,signature);}catch{return false;}});
  if(!signed)throw new Error('release_signature_invalid');
  const value=JSON.parse(bytes.toString('utf8'));
  if(value.schema!==1||!versionPattern.test(value.version)||!['stable','preview'].includes(value.channel)||value.releaseId!==`${value.channel==='preview'?'preview-v':'v'}${value.version}`||!Number.isSafeInteger(value.sequence)||value.sequence<1||channel==='stable'&&value.channel!=='stable'||value.platform!=='win32'||value.arch!==arch||value.minUpdater!==1||value.contractVersion!==contract||!Number.isFinite(Date.parse(value.issuedAt))||!Number.isFinite(Date.parse(value.expiresAt)))throw new Error('release_incompatible');
  if(Date.parse(value.issuedAt)>now+300000||Date.parse(value.expiresAt)<=now||Date.parse(value.expiresAt)<=Date.parse(value.issuedAt))throw new Error('release_metadata_expired');
  if(value.sequence<=sequence||compare(value.version,version)<=0)throw new Error('release_replay_or_downgrade');
  if(!/^[a-p]{32}$/.test(value.extensionId)||!Array.isArray(value.artifacts)||value.artifacts.length>8)throw new Error('invalid_release_manifest');
  const names=new Set();
  for(const artifact of value.artifacts) {
    if(!/^[a-zA-Z0-9._-]+$/.test(artifact.name)||names.has(artifact.name)||!['payload','extension','installer'].includes(artifact.kind)||!Number.isSafeInteger(artifact.size)||artifact.size<1||artifact.size>1_500_000_000||!/^[a-f0-9]{64}$/.test(artifact.sha256))throw new Error('invalid_release_artifact');
    names.add(artifact.name);
    if(artifact.url!==`${repository}/releases/download/${value.releaseId}/${artifact.name}`)throw new Error('invalid_release_url');
  }
  if(value.artifacts.filter(item=>item.kind==='payload').length!==1)throw new Error('invalid_release_manifest');
  return value;
}
export async function hashFile(file) {
  const handle=await open(file,'r'),hash=createHash('sha256');
  try{for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);return hash.digest('hex');}finally{await handle.close();}
}
export async function download(url,destination,{maximum=65536,size,sha256,request=fetch}={}) {
  let current=new URL(url),response;
  for(let i=0;i<5;i++) {
    if(current.protocol!=='https:'||current.username||current.password||current.port||!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(current.hostname))throw new Error('update_download_origin');
    response=await request(current,{redirect:'manual',signal:AbortSignal.timeout(120000),headers:{'User-Agent':'tabora-browser-updater'}});
    if(![301,302,303,307,308].includes(response.status))break;
    const location=response.headers.get('location');await response.body?.cancel();if(!location)throw new Error('update_download_redirect');current=new URL(location,current);response=undefined;
  }
  if(!response?.ok||!response.body||Number(response.headers.get('content-length')??0)>maximum)throw new Error('update_download_failed');
  const handle=destination?await open(destination,'wx'):undefined, chunks=[],hash=createHash('sha256');let length=0;
  try {
    for await(const chunk of response.body){length+=chunk.length;if(length>maximum)throw new Error('update_download_limit');hash.update(chunk);if(handle)await handle.writeFile(chunk);else chunks.push(chunk);}
    if(size!==undefined&&length!==size||sha256&&hash.digest('hex')!==sha256)throw new Error('update_download_integrity');
    return destination??Buffer.concat(chunks);
  } finally {await handle?.close();}
}
