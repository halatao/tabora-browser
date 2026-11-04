import path from 'node:path';
import {readFile,lstat} from 'node:fs/promises';
import {createHash,createPublicKey} from 'node:crypto';

export function publicKeyId(key){
  const der=createPublicKey(key).export({type:'spki',format:'der'});
  return createHash('sha256').update(der).digest('hex').slice(0,32).replace(/[0-9a-f]/g,value=>String.fromCharCode(97+parseInt(value,16)));
}
export async function extensionIdentities(root){
  const unpacked=(await readFile(path.join(root,'extension-id.txt'),'utf8')).trim();
  if(!/^[a-p]{32}$/.test(unpacked))throw new Error('invalid_extension_id');
  let identities;
  try{identities=JSON.parse(await readFile(path.join(root,'extension-identities.json'),'utf8'));}
  catch(error){if(error.code==='ENOENT')return {schema:1,unpacked};throw error;}
  if(identities.schema!==1||identities.unpacked!==unpacked||!/^[a-p]{32}$/.test(identities.store)||identities.store===unpacked||Object.keys(identities).sort().join(',')!=='schema,store,unpacked')throw new Error('invalid_extension_identities');
  return identities;
}
export function nativeExtensionIds(identities,channel){
  if(!['unpacked','store'].includes(channel))throw new Error('invalid_extension_channel');
  if(channel==='store'&&!identities.store)throw new Error('store_identity_unavailable');
  return channel==='store'?[identities.unpacked,identities.store]:[identities.unpacked];
}
export function nativeExtensionChannel(origin,identities,channel='unpacked'){
  const id=nativeExtensionIds(identities,channel).find(value=>origin===`chrome-extension://${value}/`);
  if(!id)throw new Error('unrecognized_extension_origin');
  return id===identities.store?'store':'unpacked';
}
export function compatibleExtension(profile,build){
  return profile.contractVersion===build.contractVersion&&(
    profile.extensionChannel==='store'&&!profile.managedProfile||profile.fingerprint===build.fingerprint
  );
}
export async function hasUnpackedExtension(root,channel){
  try{
    const info=await lstat(path.join(root,'extension-unpacked'));
    if(!info.isDirectory()||info.isSymbolicLink())throw new Error('invalid_unpacked_directory');
    return true;
  }catch(error){if(error.code==='ENOENT'&&channel==='store')return false;throw error;}
}
