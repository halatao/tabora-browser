import path from 'node:path';
import {lstat,rm,readdir,unlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {confined,plainDirectory,files,json} from './files.mjs';

async function removeTree(parent,relative){
  await plainDirectory(parent);const target=confined(parent,relative);
  try{await lstat(target);}catch(error){if(error.code==='ENOENT')return;throw error;}
  await plainDirectory(target);await files(target);
  // confined + realpath validation above precede every recursive removal.
  await rm(target,{recursive:true,force:false});
}
export async function cleanupInstallation(root,stateDir,installationId,currentJob,inUse){
  const config=await json(path.join(root,'installation.json')),deferred=[];
  if(config.id!==installationId||!/^\d+\.\d+\.\d+-[a-f0-9]{16}$/.test(config.current)||config.previous&&!/^\d+\.\d+\.\d+-[a-f0-9]{16}$/.test(config.previous))throw new Error('cleanup_installation_mismatch');
  const versions=path.join(root,'versions');await plainDirectory(versions);
  const processCheck=inUse??(async directory=>{
    try{
      return execFileSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(versions,config.current,'scripts/distribution/process-check.ps1')],{windowsHide:true,encoding:'utf8',env:{...process.env,TABORA_PROCESS_DIRECTORY:directory}}).trim()!=='idle';
    }catch{return true;}
  });
  for(const name of await readdir(versions)){
    if(!/^\d+\.\d+\.\d+-[a-f0-9]{16}$/.test(name)||[config.current,config.previous].includes(name))continue;
    const directory=confined(versions,name);
    if(await processCheck(directory)){deferred.push(name);continue;}
    try{
      const descriptor=await json(path.join(directory,'package-info.json'),16_000_000);
      if(descriptor.schema!==1||descriptor.versionId!==name)throw new Error('cleanup_ownership_unverified');
      await removeTree(versions,name);
    }catch{deferred.push(name);}
  }
  const jobs=path.join(stateDir,'updates');
  try{await plainDirectory(jobs);}catch(error){if(error.code==='ENOENT')return {deferred};throw error;}
  for(const id of await readdir(jobs)){
    if(!/^[a-f0-9-]{36}$/.test(id))continue;
    try{
      const job=await json(path.join(jobs,id,'journal.json'));
      if(job.installationId!==installationId||job.id!==id||!['mcp_restart_required','completed','rolled_back','verification_failed'].includes(job.status))continue;
      for(const name of ['payload','apply-payload'])await removeTree(jobs,id+'/'+name);
      const archive=confined(jobs,id+'/payload.zip');
      try{const info=await lstat(archive);if(!info.isFile()||info.isSymbolicLink())throw new Error('cleanup_ownership_unverified');await unlink(archive);}catch(error){if(error.code!=='ENOENT')throw error;}
      if(id!==currentJob)for(const prefix of ['extension-previous-','extension-staging-','extension-failed-'])await removeTree(root,prefix+id);
    }catch{deferred.push(id);}
  }
  return {deferred};
}
