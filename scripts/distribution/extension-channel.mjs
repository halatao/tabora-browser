import path from 'node:path';
import {mkdir,writeFile,unlink,rmdir,cp,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {installation,validatePayload,register} from './installation.mjs';
import {json,atomicJson} from './files.mjs';
import {extensionIdentities,nativeExtensionIds,hasUnpackedExtension} from './extension-identity.mjs';

function idle(installed){
  return execFileSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(installed.version,'scripts/distribution/process-check.ps1')],{windowsHide:true,encoding:'utf8',env:{...process.env,TABORA_PROCESS_DIRECTORY:installed.version,TABORA_PROCESS_EXCLUDE:String(process.pid)}}).trim()==='idle';
}
export async function switchExtensionChannel(root,channel,{registration=register,isIdle=idle}={}){
  const installed=await installation(root),identities=await extensionIdentities(installed.version);
  const allowed=nativeExtensionIds(identities,channel);
  if(identities.unpacked!==installed.config.extensionId)throw new Error('extension_identity_migration_required');
  await validatePayload(installed.version);
  if(channel===installed.config.installKind)return {changed:false,channel,extensionId:identities[channel],allowedExtensionIds:allowed};
  const lock=path.join(installed.root,'update.lock'),id=randomUUID();
  try{await mkdir(lock);}catch(error){if(error.code==='EEXIST')throw new Error('update_already_applying');throw error;}
  let retainLock=false;
  try{
    await writeFile(path.join(lock,'owner.json'),JSON.stringify({id,pid:process.pid,kind:'extension-channel',installationId:installed.config.id}));
    if(JSON.stringify((await installation(installed.root)).config)!==JSON.stringify(installed.config))throw new Error('installation_changed_retry');
    if(!await isIdle(installed))throw new Error('extension_channel_requires_idle: finish tasks, disable connected Tabora extensions and close MCP clients; ordinary browser tabs may remain open.');
    if(channel==='unpacked'&&!await hasUnpackedExtension(installed.root,'store')){
      const staging=path.join(installed.root,'extension-channel-'+id);
      await cp(path.join(installed.version,'dist/extension'),staging,{recursive:true,errorOnExist:true,force:false});
      await rename(staging,path.join(installed.root,'extension-unpacked'));
    }
    await atomicJson(path.join(installed.root,'installation.json'),{...installed.config,installKind:channel});
    try{await registration(installed.root);}
    catch(error){
      retainLock=true;
      try{await atomicJson(path.join(installed.root,'installation.json'),installed.config);await registration(installed.root);}catch{throw new Error('extension_channel_repair_required');}
      retainLock=false;
      throw error;
    }
    return {changed:true,channel,extensionId:identities[channel],allowedExtensionIds:allowed,dataRetained:true,profilePermissionsTransferred:false,storeUrl:identities.store?`https://chromewebstore.google.com/detail/${identities.store}`:undefined};
  }finally{if(!retainLock){await unlink(path.join(lock,'owner.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});await rmdir(lock);}}
}
export async function recoverExtensionChannel(root,{registration=register}={}){
  const installed=await installation(root),lock=path.join(installed.root,'update.lock');let owner;
  try{owner=await json(path.join(lock,'owner.json'));}catch(error){if(error.code==='ENOENT')return false;throw error;}
  if(owner.kind!=='extension-channel')return false;
  if(owner.installationId!==installed.config.id||!Number.isSafeInteger(owner.pid)||owner.pid<1)throw new Error('update_lock_review_required');
  try{process.kill(owner.pid,0);throw new Error('updater_still_running');}catch(error){if(error.code!=='ESRCH')throw error;}
  await validatePayload(installed.version);
  const identities=await extensionIdentities(installed.version);
  if(identities.unpacked!==installed.config.extensionId)throw new Error('extension_identity_migration_required');
  nativeExtensionIds(identities,installed.config.installKind);
  await registration(installed.root);
  await unlink(path.join(lock,'owner.json'));await rmdir(lock);
  return true;
}
