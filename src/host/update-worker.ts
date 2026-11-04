import path from 'node:path';
import {mkdir,rename,cp,lstat,rmdir,writeFile,unlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {installation,validatePayload} from '../../scripts/distribution/installation.mjs';
import {atomicJson,json,plainDirectory} from '../../scripts/distribution/files.mjs';
import {hashFile,compare} from '../../scripts/distribution/release.mjs';
import {extract} from '../../scripts/distribution/archive.mjs';
import {UpdateChecker} from './updates.js';
import {buildInfo} from '../build-info.js';
import {cleanupInstallation} from '../../scripts/distribution/cleanup.mjs';
import {InstallationUpdates,updateId} from './installation-updates.js';
import {connectBroker} from './broker-client.js';
import {PilotError,safeCode} from '../shared.js';
import {compatibleExtension,hasUnpackedExtension} from '../../scripts/distribution/extension-identity.mjs';

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
type ManagedProfile={id:string;name:string;headless:boolean};
async function managedCommand(version:string,name:string,command:'start'|'stop'|'status',headless=false){
  const result=await promisify(execFile)(path.join(version,'runtime/node.exe'),[path.join(version,'scripts/browser.mjs'),command,'--profile',name,...(command==='start'&&headless?['--headless']:[])],{windowsHide:true,timeout:65000,env:process.env});
  return command==='status'?JSON.parse(result.stdout):undefined;
}
export async function updateCli(operation:string,id?:string,ticket?:string){
  const service=new InstallationUpdates();
  if(operation==='check'){const local=await service.check();return {...(local.policy==='off'?{status:'disabled',installed:buildInfo}:await new UpdateChecker(buildInfo,process.env.TABORA_STATE_DIR).forChannel(local.channel==='preview'?'preview':'stable').check()),...local};}
  if(operation==='prepare')return service.prepare();
  if(operation==='status')return service.status(updateId.parse(id));
  if(operation==='apply')return service.apply(updateId.parse(id),ticket??'');
  if(operation==='recover')return recover();
  throw new PilotError('unknown_update_operation');
}
async function recover(){
  const root=process.env.TABORA_INSTALL_ROOT;if(!root)throw new PilotError('installed_root_required');
  const installed=await installation(root),lock=path.join(root,'update.lock');let owner:any;
  try{owner=await json(path.join(lock,'owner.json'));}catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    try{await lstat(lock);}catch(missing){if((missing as NodeJS.ErrnoException).code==='ENOENT')return {recoveryRequired:false};throw missing;}
    throw new PilotError('update_lock_review_required');
  }
  const id=updateId.parse(owner.id);if(!Number.isSafeInteger(owner.pid)||owner.pid<1)throw new PilotError('update_lock_review_required');
  try{process.kill(owner.pid,0);throw new PilotError('updater_still_running');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
  await plainDirectory(lock);
  const file=path.join(installed.config.stateDir,'updates',id,'journal.json'),record=await json(file);
  if(record.installationId!==installed.config.id||record.id!==id)throw new PilotError('update_not_owned');
  if(['mcp_restart_required','rolled_back'].includes(record.status)){await unlink(path.join(lock,'owner.json'));await rmdir(lock);return {recovered:true,status:record.status};}
  if(!record.previousConfig||record.previousConfig.id!==installed.config.id||!/^\d+\.\d+\.\d+-[a-f0-9]{16}$/.test(record.previousConfig.current))throw new PilotError('update_lock_review_required');
  if(['scheduled','extracting','preparing_browser'].includes(record.status)&&!record.checkpoint&&installed.config.current===record.previousConfig.current){
    await atomicJson(file,{...record,status:'rolled_back',programRestored:true,code:'updater_interrupted_before_activation'});
    await unlink(path.join(lock,'owner.json'));await rmdir(lock);return {recovered:true,status:'rolled_back',updateId:id};
  }
  const peer=await connectBroker('mcp');
  try{
    const preparation=await peer.call('maintenance.prepare',{updateId:id});if(!preparation.ready)return {status:'waiting_for_idle',updateId:id};
    const backup=path.join(root,'extension-previous-'+id),extension=path.join(root,'extension-unpacked');
    try{
      await plainDirectory(backup);
      try{await rename(extension,path.join(root,'extension-recovery-'+crypto.randomUUID()));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      await rename(backup,extension);
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    await atomicJson(path.join(root,'installation.json'),record.previousConfig);
    await peer.call('maintenance.finish',{updateId:id}).catch(error=>{if(safeCode(error)!=='connection_lost')throw error;});
    for(const profile of record.managedProfiles??[])await managedCommand(path.join(root,'versions',record.previousConfig.current),profile.name,'start',profile.headless);
    await promisify(execFile)(path.join(root,'tabora.exe'),['doctor'],{windowsHide:true,timeout:120000,env:process.env});
    await atomicJson(file,{...record,status:'rolled_back',programRestored:true,nextStep:'Reconnect MCP. Review any recorded uncertain outcomes before new writes.'});
    await unlink(path.join(lock,'owner.json'));await rmdir(lock);return {recovered:true,status:'rolled_back',updateId:id};
  }finally{peer.close();}
}
async function apply(id:string){
  updateId.parse(id);const root=process.env.TABORA_INSTALL_ROOT;if(!root)throw new Error('installed_root_required');
  const installed=await installation(root),directory=path.join(installed.config.stateDir,'updates',id),file=path.join(directory,'journal.json');
  const record=await json(file);if(record.id!==id||record.installationId!==installed.config.id||record.status!=='scheduled')throw new Error('update_not_scheduled');
  const lock=path.join(root,'update.lock');
  try{await mkdir(lock);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;await atomicJson(file,{...record,status:'waiting_for_other_update',code:'update_lock_held'});return;}
  await writeFile(path.join(lock,'owner.json'),JSON.stringify({id,pid:process.pid,at:Date.now()}),{flag:'wx'});
  let peer:Awaited<ReturnType<typeof connectBroker>>|undefined,switched=false,oldMoved=false,newMoved=false,stopped=false,retainLock=false,acquired=false,activationAttempted=false;
  const managed:ManagedProfile[]=[],managedStopped:ManagedProfile[]=[];
  const previous=path.join(root,'extension-previous-'+id),extension=path.join(root,'extension-unpacked');
  const progress=async(status:string,extra={})=>{Object.assign(record,extra,{status,updatedAt:Date.now()});return atomicJson(file,record);};
  try {
    if(JSON.stringify((await installation(root)).config)!==JSON.stringify(installed.config))throw new Error('installation_changed_retry');
    await progress('scheduled',{previousConfig:installed.config});
    const currentBuild=await json(path.join(installed.version,'dist/build-info.json'));
    if(installed.config.policy==='off'&&record.source!=='local-installer')throw new Error('update_checks_disabled');
    if(compare(record.manifest.version,currentBuild.version)<=0||record.source!=='local-installer'&&record.manifest.sequence<=installed.config.sequence)throw new Error('release_replay_or_downgrade');
    if(record.source!=='local-installer'&&installed.config.channel==='stable'&&record.manifest.channel!=='stable')throw new Error('release_channel_changed');
    const artifact=record.manifest.artifacts.find((item:any)=>item.kind==='payload');
    if(await hashFile(path.join(directory,'payload.zip'))!==artifact.sha256)throw new Error('staged_payload_changed');
    await progress('extracting');
    const payload=path.join(directory,'apply-payload');await extract(path.join(directory,'payload.zip'),payload);
    const validated=await validatePayload(payload);if(validated.id!==record.versionId)throw new Error('staged_payload_changed');
    peer=await connectBroker('mcp');
    if(peer.capabilities?.updateLifecycleVersion!==1)throw new Error('broker_update_required');
    const discovery=await peer.call('maintenance.health',{});
    for(const profile of discovery.profiles.filter((profile:any)=>profile.managedProfile)){
      const status=await managedCommand(installed.version,profile.managedProfile,'status');
      if(!status?.ready||status.profileId!==profile.id)throw new Error('managed_profile_identity_mismatch');
      managed.push({id:profile.id,name:profile.managedProfile,headless:status.headless===true});
    }
    if(managed.length){
      await progress('preparing_browser',{managedProfiles:managed});
      await promisify(execFile)(path.join(payload,'runtime/node.exe'),[path.join(payload,'scripts/cli.mjs'),'browser','install'],{windowsHide:true,timeout:300000,env:process.env});
    }
    await progress('waiting_for_idle');
    let preparation:any;
    for(;;){preparation=await peer.call('maintenance.prepare',{updateId:id});acquired=true;if(preparation.ready)break;await sleep(1000);}
    if(preparation.managedProfiles.length!==managed.length||preparation.managedProfiles.some((profile:any)=>!managed.some(known=>known.id===profile.id)))throw new Error('managed_profile_set_changed');
    if(preparation.build.fingerprint!==(await json(path.join(installed.version,'dist/build-info.json'))).fingerprint)throw new Error('broker_update_required');
    await progress('applying',{profiles:preparation.profiles,uncertainSessions:preparation.uncertainSessions,requiresOutcomeReview:preparation.uncertainSessions?.length>0});
    for(const profile of managed){await managedCommand(installed.version,profile.name,'stop');managedStopped.push(profile);}
    const version=path.join(root,'versions',validated.id),staging=version+'.staging-'+id;
    let exists=false;try{await lstat(version);exists=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(exists){if(await hashFile(path.join(version,'package-info.json'))!==await hashFile(path.join(payload,'package-info.json')))throw new Error('version_directory_conflict');await validatePayload(version);}
    else{await cp(payload,staging,{recursive:true,errorOnExist:true,force:false});await rename(staging,version);}
    if(await hasUnpackedExtension(root,installed.config.installKind)) {
      const next=path.join(root,'extension-staging-'+id);await cp(path.join(version,'dist/extension'),next,{recursive:true,errorOnExist:true,force:false});
      await rename(extension,previous);oldMoved=true;await progress('applying',{checkpoint:'extension_old_moved'});
      await rename(next,extension);newMoved=true;await progress('applying',{checkpoint:'extension_replaced'});
    }
    if(record.nextChannel!==undefined&&!['stable','preview'].includes(record.nextChannel))throw new Error('invalid_update_channel');
    if(record.nextPolicy!==undefined&&!['off','notify','idle-auto'].includes(record.nextPolicy))throw new Error('invalid_update_policy');
    await atomicJson(path.join(root,'installation.json'),{...installed.config,current:validated.id,previous:installed.config.current,sequence:record.manifest.sequence,channel:record.source==='local-installer'?(record.nextChannel??installed.config.channel):installed.config.channel,policy:record.source==='local-installer'?(record.nextPolicy??installed.config.policy):installed.config.policy});switched=true;
    await progress('applying',{checkpoint:'pointer_switched'});
    // prepare response has already reached the worker. finish is an intentional disconnect,
    // not an ambiguous browser write, and no business action is repeated here.
    activationAttempted=true;
    await peer.call('maintenance.finish',{updateId:id}).catch(error=>{if(safeCode(error)!=='connection_lost')throw error;});peer.close();peer=undefined;stopped=true;
    await progress('health_check');
    for(const profile of managedStopped)await managedCommand(version,profile.name,'start',profile.headless);
    await promisify(execFile)(path.join(root,'tabora.exe'),['doctor'],{windowsHide:true,timeout:60000,env:process.env});
    peer=await connectBroker('mcp');
    const deadline=Date.now()+60000;let extensionVerified=false;
    for(;;){
      const health=await peer.call('maintenance.health',{});
      const profiles=preparation.profiles as string[];
      if(health.build.fingerprint===validated.info.fingerprint&&profiles.every(id=>health.profiles.some((profile:any)=>profile.id===id&&compatibleExtension(profile,validated.info)))){extensionVerified=profiles.length>0;break;}
      if(Date.now()>deadline){if(health.build.fingerprint!==validated.info.fingerprint)throw new Error('update_health_failed');break;}await sleep(1000);
    }
    await progress('mcp_restart_required',{checkpoint:'host_verified',hostVersion:validated.info.version,extensionVerified,nextStep:extensionVerified?'Reconnect MCP clients to load the new server code. Browser actions were not replayed.':'Host and extension files installed. Connect the browser profile, complete browser consent if requested, and reconnect MCP. No browser action was replayed.'});
    const cleanup=await cleanupInstallation(root,installed.config.stateDir,installed.config.id,id).catch(()=>({deferred:['cleanup_unavailable']}));
    await progress('mcp_restart_required',{cleanup}).catch(()=>{});
  } catch(error) {
    let restored=true;
    try {
      if(switched)await atomicJson(path.join(root,'installation.json'),installed.config);
      if(newMoved)await rename(extension,path.join(root,'extension-failed-'+id));
      if(oldMoved)await rename(previous,extension);
    }catch{restored=false;}
    if(peer&&!stopped&&acquired)await peer.call('maintenance.resume',{updateId:id}).catch(()=>{restored=false;});
    if(!stopped)for(const profile of managedStopped)await managedCommand(installed.version,profile.name,'start',profile.headless).catch(()=>{restored=false;});
    retainLock=stopped||activationAttempted||!restored;
    await progress(retainLock?'recovery_required':'rolled_back',{code:/^[a-z_]+$/.test((error as Error).message)?(error as Error).message:'update_apply_failed',programRestored:restored,nextStep:stopped?'Run tabora repair after the updater exits; reconnect MCP and inspect uncertain action outcomes before retrying.':undefined});
  } finally {
    peer?.close();
    // Only remove the lock created above, never a caller-selected tree.
    if(!retainLock){await unlink(path.join(lock,'owner.json'));await rmdir(lock);}
  }
}
const invoked=process.argv[1]?path.resolve(process.argv[1]):'',moduleFile=fileURLToPath(import.meta.url);
if(process.argv[2]==='apply-worker'&&(process.platform==='win32'?invoked.toLowerCase()===moduleFile.toLowerCase():invoked===moduleFile)){
  await apply(process.argv[3]);
}
