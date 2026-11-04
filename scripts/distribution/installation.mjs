import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir, cp, copyFile, readFile, lstat, readdir, rename} from 'node:fs/promises';
import {execFileSync, spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {json, atomicJson, confined, plainDirectory,mapBounded,files} from './files.mjs';
import {hashFile} from './release.mjs';
import {compare} from './release.mjs';
import {zip} from './archive.mjs';
import {extensionIdentities,hasUnpackedExtension} from './extension-identity.mjs';

export async function installation(root,{allowMissingVersion=false}={}) {
  root=await plainDirectory(root);
  const config=await json(path.join(root,'installation.json'));
  config.channel??='stable';if(!['stable','preview'].includes(config.channel))throw new Error('invalid_update_channel');
  if(config.schema!==1||config.product!=='tabora-browser'||!/^[a-f0-9-]{36}$/.test(config.id)||!/^\d+\.\d+\.\d+-[a-f0-9]{16}$/.test(config.current)||!path.isAbsolute(config.stateDir)||!path.isAbsolute(config.requestedStateDir)||!['unpacked','store'].includes(config.installKind)||!['off','notify','idle-auto'].includes(config.policy)||!Number.isSafeInteger(config.sequence)||config.sequence<0||!/^[a-p]{32}$/.test(config.extensionId))throw new Error('invalid_installation');
  const version=confined(root,'versions/'+config.current);if(!allowMissingVersion)await plainDirectory(version);
  return {root,config,version};
}
async function repairProgram(payload,existing){
  try{await validatePayload(existing.version);return;}catch{}
  const busy=execFileSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(payload,'scripts/distribution/process-check.ps1')],{windowsHide:true,encoding:'utf8',env:{...process.env,TABORA_PROCESS_DIRECTORY:existing.version}}).trim();
  if(busy!=='idle')throw new Error('repair_requires_idle_installation');
  const staged=existing.version+'.repair-'+randomUUID(),backup=existing.version+'.damaged-'+randomUUID();
  await cp(payload,staged,{recursive:true,errorOnExist:true,force:false});let moved=false;
  try{await rename(existing.version,backup);moved=true;}catch(error){if(error.code!=='ENOENT')throw error;}
  try{await rename(staged,existing.version);}catch(error){if(moved)await rename(backup,existing.version);throw error;}
  await copyFile(path.join(payload,'tabora.exe'),path.join(existing.root,'tabora.exe'));
}
async function repairEntryPoints(payload,existing){
  const expectedLauncher=await hashFile(path.join(payload,'tabora.exe'));let actualLauncher;
  try{actualLauncher=await hashFile(path.join(existing.root,'tabora.exe'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(actualLauncher!==expectedLauncher)await copyFile(path.join(payload,'tabora.exe'),path.join(existing.root,'tabora.exe'));
  if(!await hasUnpackedExtension(existing.root,existing.config.installKind))return;
  const source=path.join(payload,'dist/extension'),target=path.join(existing.root,'extension-unpacked'),canonical=await json(path.join(source,'manifest.json'));
  let previous;try{previous=await json(path.join(target,'manifest.json'));}catch{throw new Error('extension_permissions_review_required');}
  if(previous.key!==canonical.key||previous.version!==canonical.version)throw new Error('extension_permissions_review_required');
  for(const key of ['permissions','optional_permissions','host_permissions','optional_host_permissions']){
    if(previous[key]!==undefined&&(!Array.isArray(previous[key])||previous[key].some(value=>typeof value!=='string'||value.length>2000)))throw new Error('extension_permissions_review_required');
    if(previous[key]!==undefined)canonical[key]=previous[key];
  }
  const replacements=[];
  for(const relative of await files(source)){
    if(relative==='manifest.json')continue;
    const wanted=await hashFile(confined(source,relative));let actual;
    try{actual=await hashFile(confined(target,relative));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(actual!==wanted)replacements.push(relative);
  }
  if(replacements.length){
    const busy=execFileSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(payload,'scripts/distribution/process-check.ps1')],{windowsHide:true,encoding:'utf8',env:{...process.env,TABORA_PROCESS_DIRECTORY:existing.version}}).trim();
    if(busy!=='idle')throw new Error('repair_requires_idle_installation');
    for(const relative of replacements){const destination=confined(target,relative),temporary=destination+'.repair-'+randomUUID();await mkdir(path.dirname(destination),{recursive:true});await copyFile(confined(source,relative),temporary);await (await import('node:fs/promises')).rename(temporary,destination);}
    await atomicJson(path.join(target,'manifest.json'),canonical);
  }
}
export function versionId(info) {
  if(!/^\d+\.\d+\.\d+$/.test(info.version)||!/^[a-f0-9]{64}$/.test(info.fingerprint)||info.contractVersion!==2)throw new Error('invalid_payload_build');
  return info.version+'-'+info.fingerprint.slice(0,16);
}
export async function validatePayload(payload) {
  await plainDirectory(payload);
  const info=await json(path.join(payload,'dist/build-info.json')), descriptor=await json(path.join(payload,'package-info.json'),16_000_000);
  const id=versionId(info),extensionId=(await readFile(path.join(payload,'extension-id.txt'),'utf8')).trim();
  await extensionIdentities(payload);
  if(descriptor.schema!==1||descriptor.platform!==process.platform||descriptor.arch!==process.arch||descriptor.versionId!==id||!/^[a-p]{32}$/.test(extensionId))throw new Error('payload_platform_mismatch');
  for(const file of ['tabora.exe','runtime/node.exe','dist/host/main.js','dist/host/mcp.js','dist/host/update-worker.js','dist/extension/manifest.json','scripts/cli.mjs','release-trust.json'])if(!(await lstat(confined(payload,file))).isFile())throw new Error('payload_incomplete');
  if(!descriptor.inventory||Object.keys(descriptor.inventory).length>50000)throw new Error('payload_inventory_invalid');
  await mapBounded(Object.entries(descriptor.inventory),async ([relative,expected])=>{
    if(typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected)||await hashFile(confined(payload,relative))!==expected)throw new Error('payload_inventory_mismatch');
  });
  const channel=descriptor.channel??'stable';if(!['stable','preview'].includes(channel))throw new Error('invalid_update_channel');
  return {info,id,extensionId,channel};
}
export function register(root,{unregister=false,migrateFrom}={}) {
  const script=path.join(root,'versions',JSON.parse(readFileSync(path.join(root,'installation.json'),'utf8')).current,'scripts/distribution/register.ps1');
  execFileSync(path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,...(unregister?['-Unregister']:[])],{env:{...process.env,TABORA_INSTALL_ROOT:root,...(migrateFrom?{TABORA_MIGRATE_FROM:path.resolve(migrateFrom)}:{})},stdio:'inherit',windowsHide:true});
}
async function upgradeLocal(payload,existing,validated,channel,policy) {
  const current=await json(path.join(existing.version,'dist/build-info.json'));
  if(compare(validated.info.version,current.version)<=0)throw new Error('local_upgrade_requires_newer_version');
  if(validated.extensionId!==existing.config.extensionId)throw new Error('extension_identity_migration_required');
  const id=randomUUID(),ticket=randomUUID(),directory=path.join(existing.config.stateDir,'updates',id);await mkdir(directory,{recursive:true});
  const archive=path.join(directory,'payload.zip');await zip(payload,archive);
  const manifest={version:validated.info.version,sequence:existing.config.sequence,source:'local-installer',artifacts:[{kind:'payload',sha256:await hashFile(archive),size:(await lstat(archive)).size}]};
  await atomicJson(path.join(directory,'journal.json'),{schema:1,installationId:existing.config.id,id,status:'staged',source:'local-installer',nextChannel:channel,nextPolicy:policy??existing.config.policy,ticketHash:createHash('sha256').update(ticket).digest('hex'),createdAt:Date.now(),versionId:validated.id,manifest});
  execFileSync(path.join(existing.root,'tabora.exe'),['update','apply',id,ticket],{windowsHide:true,stdio:'pipe'});
  return {...existing,status:'scheduled',updateId:id};
}
export async function install(payload,root,{stateDir,policy,migrateFrom,registration=register,channel,extensionChannel}={}) {
  if(process.platform!=='win32')throw new Error('windows_required');
  const validated=await validatePayload(payload),{id,extensionId}=validated;root=path.resolve(root);
  const selectedChannel=channel??validated.channel;if(!['stable','preview'].includes(selectedChannel))throw new Error('invalid_update_channel');
  if(extensionChannel!==undefined&&!['unpacked','store'].includes(extensionChannel))throw new Error('invalid_extension_channel');
  if(extensionChannel==='store'&&!(await extensionIdentities(payload)).store)throw new Error('store_identity_unavailable');
  if(policy!==undefined&&!['off','notify','idle-auto'].includes(policy))throw new Error('invalid_update_policy');
  const requestedInstallRoot=root;
  await mkdir(root,{recursive:true});
  root=execFileSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(payload,'scripts/distribution/resolve-install.ps1')],{env:{...process.env,TABORA_REQUESTED_INSTALL_ROOT:root},encoding:'utf8',windowsHide:true}).trim();
  if(!path.isAbsolute(root))throw new Error('invalid_physical_installation');await plainDirectory(root);
  let existing;
  try{existing=await installation(root,{allowMissingVersion:true});}catch(error){if(error.code!=='ENOENT')throw error;}
  if(existing){
    if(existing.config.extensionId!==validated.extensionId)throw new Error('extension_identity_migration_required');
    if(migrateFrom){const source=await json(path.join(path.resolve(migrateFrom),'dist/native-host/state.json'));if(source.version!==1||!path.isAbsolute(source.stateDir)||path.resolve(source.stateDir).toLowerCase()!==path.resolve(existing.config.stateDir).toLowerCase())throw new Error('migration_state_mismatch');}
    if(extensionChannel&&extensionChannel!==existing.config.installKind)throw new Error('extension_channel_migration_required');
    if(existing.config.current!==id)return upgradeLocal(payload,existing,validated,channel??existing.config.channel,policy);
    await repairProgram(payload,existing);await repairEntryPoints(payload,existing);
    if(channel||policy){existing.config.channel=channel??existing.config.channel;existing.config.policy=policy??existing.config.policy;await atomicJson(path.join(root,'installation.json'),existing.config);}
    registration(root,{migrateFrom});return existing;
  }
  if((await readdir(root)).some(name=>!/^unins\d+\.(exe|dat|msg)$/i.test(name)))throw new Error('installation_directory_not_empty');
  if(registration===register)execFileSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(payload,'scripts/distribution/register.ps1'),'-CheckOnly'],{env:{...process.env,TABORA_INSTALL_ROOT:root,TABORA_PREFLIGHT_EXTENSION_ID:extensionId,...(migrateFrom?{TABORA_MIGRATE_FROM:path.resolve(migrateFrom)}:{})},windowsHide:true,stdio:'inherit'});
  let requestedStateDir=stateDir;
  if(migrateFrom) {
    const old=await json(path.join(path.resolve(migrateFrom),'dist/native-host/state.json'));
    if(old.version!==1||!path.isAbsolute(old.stateDir))throw new Error('invalid_source_installation');
    if(stateDir&&path.resolve(stateDir).toLowerCase()!==path.resolve(old.stateDir).toLowerCase())throw new Error('migration_state_mismatch');
    requestedStateDir=old.requestedStateDir??old.stateDir;stateDir=old.stateDir;
  }
  stateDir=path.resolve(stateDir??path.join(process.env.LOCALAPPDATA,'TaboraBrowser'));requestedStateDir=path.resolve(requestedStateDir??stateDir);
  await mkdir(stateDir,{recursive:true});
  // Resolve MSIX aliases using the same Windows handle-based resolver as source setup.
  const physical=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(payload,'scripts/distribution/resolve-state.ps1')],{env:{...process.env,TABORA_PHYSICAL_INPUT:stateDir},encoding:'utf8',windowsHide:true}).trim();
  if(!path.isAbsolute(physical))throw new Error('invalid_physical_state');stateDir=physical;
  if(stateDir.toLowerCase()===root.toLowerCase()||stateDir.toLowerCase().startsWith(root.toLowerCase()+path.sep))throw new Error('data_directory_overlaps_program');
  const version=confined(root,'versions/'+id);await mkdir(path.dirname(version),{recursive:true});await cp(payload,version,{recursive:true,errorOnExist:true,force:false});
  if(extensionChannel!=='store')await cp(path.join(version,'dist/extension'),path.join(root,'extension-unpacked'),{recursive:true,errorOnExist:true,force:false});
  await copyFile(path.join(version,'tabora.exe'),path.join(root,'tabora.exe'));
  const config={schema:1,product:'tabora-browser',id:randomUUID(),current:id,requestedInstallRoot,stateDir,requestedStateDir,extensionId,installKind:extensionChannel??'unpacked',channel:selectedChannel,policy:policy??'notify',sequence:0};
  await atomicJson(path.join(root,'installation.json'),config);
  registration(root,{migrateFrom});return {root,config,version};
}
export async function removeRegistration(root) {await installation(root);register(root,{unregister:true});return {unregistered:true,dataRetained:true};}
export async function validateUninstall(root){
  const installed=await installation(root);await files(root);
  const busy=execFileSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(installed.version,'scripts/distribution/process-check.ps1')],{windowsHide:true,encoding:'utf8',env:{...process.env,TABORA_PROCESS_DIRECTORY:path.join(root,'versions'),TABORA_PROCESS_EXCLUDE:String(process.pid)}}).trim();
  if(busy!=='idle')throw new Error('installation_in_use');return {owned:true};
}
export async function doctor(root,requireProfile=false) {
  const installed=await installation(root),validated=await validatePayload(installed.version);
  const child=spawn(path.join(root,'tabora.exe'),['mcp'],{env:process.env,windowsHide:true,stdio:['pipe','pipe','ignore']});
  let text='',next=0;const pending=new Map();
  const request=(method,params)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  const timer=setTimeout(()=>child.kill(),30000);
  child.stdout.on('data',chunk=>{text+=chunk;if(text.length>2_000_000){child.kill();return;}while(text.includes('\n')){const index=text.indexOf('\n'),line=text.slice(0,index);text=text.slice(index+1);try{const response=JSON.parse(line),p=pending.get(response.id);if(p){pending.delete(response.id);response.error?p.reject(new Error('mcp_health_failed')):p.resolve(response.result);}}catch{child.kill();}}});
  child.on('error',()=>{for(const p of pending.values())p.reject(new Error('mcp_launch_failed'));pending.clear();});
  child.on('exit',()=>{for(const p of pending.values())p.reject(new Error('mcp_health_failed'));pending.clear();});
  try {
    await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'tabora-package-doctor',version:'1.0.0'}});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const tools=await request('tools/list',{});if(!tools.tools.some(tool=>tool.name==='browser_update_status'))throw new Error('mcp_contract_incomplete');
    const response=await request('tools/call',{name:'browser_profiles',arguments:{}});if(response.isError)throw new Error('mcp_health_failed');
    const allProfiles=JSON.parse(response.content[0].text),profiles=allProfiles.filter(profile=>(profile.extensionChannel??'unpacked')===installed.config.installKind);if(requireProfile&&!profiles.length)throw new Error('profile_connection_required');
    if(requireProfile){
      const created=await request('tools/call',{name:'browser_session_create',arguments:{profileId:profiles[0].id,name:'Installation health check'}});if(created.isError)throw new Error('profile_health_failed');
      const session=JSON.parse(created.content[0].text);
      try{
        const result=await request('tools/call',{name:'browser_capabilities',arguments:{sessionId:session.id}});if(result.isError)throw new Error('profile_health_failed');
        const capabilities=JSON.parse(result.content[0].text);
        if(capabilities.build?.host?.fingerprint!==validated.info.fingerprint)throw new Error('broker_restart_required');
        if(capabilities.build.compatible!==true||profiles[0].extensionChannel!=='store'&&capabilities.build.extension?.fingerprint!==validated.info.fingerprint)throw new Error('extension_update_required');
      }finally{await request('tools/call',{name:'browser_session_release',arguments:{sessionId:session.id,closeCreatedTabs:false}});}
    }
    const identities=await extensionIdentities(installed.version);
    return {installed:true,mcp:true,profileConnected:profiles.length>0,runtimeVerified:requireProfile,profileCount:profiles.length,version:installed.config.current,extensionId:identities[installed.config.installKind],extensionChannel:installed.config.installKind,extensionDirectory:installed.config.installKind==='unpacked'?path.join(root,'extension-unpacked'):undefined};
  } finally {clearTimeout(timer);child.stdin.end();child.kill();}
}
