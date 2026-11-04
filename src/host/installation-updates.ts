import path from 'node:path';
import {randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {mkdir,lstat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {z} from 'zod';
import {PilotError} from '../shared.js';
import {installation,validatePayload} from '../../scripts/distribution/installation.mjs';
import {atomicJson,json} from '../../scripts/distribution/files.mjs';
import {releaseManifest,download,repository,compare} from '../../scripts/distribution/release.mjs';
import {extract} from '../../scripts/distribution/archive.mjs';
import {UpdateChecker} from './updates.js';

export const updateId=z.string().uuid();
type RecordData={schema:1;installationId:string;id:string;status:string;ticketHash:string;createdAt:number;source?:'remote'|'local-installer';code?:string;manifest?:any;versionId?:string;profiles?:string[]};
export class InstallationUpdates {
  private pending?:Promise<void>;
  private failures=new Set<string>();
  constructor(private root=process.env.TABORA_INSTALL_ROOT,private request:typeof fetch=fetch){}
  startAutomatic(checker:UpdateChecker){
    const attempt=async()=>{
      try {
        const local=await this.check();if(local.policy!=='idle-auto'||!local.remoteInstallationAvailable)return;
        const advisory=await checker.forChannel(local.channel==='preview'?'preview':'stable').check();if(advisory.status!=='update_available'||!['release','preview-release'].includes(advisory.source??''))return;
        const prepared=await this.prepare();await this.pending;
        if((await this.status(prepared.updateId)).status==='staged')await this.apply(prepared.updateId,prepared.ticket);
      }catch{/* Advisory update failures never interrupt browser execution. Durable jobs expose their own errors. */}
    };
    const first=setTimeout(()=>void attempt(),30000),periodic=setInterval(()=>void attempt(),6*60*60*1000);first.unref();periodic.unref();
  }
  private async installed(){if(!this.root)throw new PilotError('source_installation_requires_manual_update');return installation(this.root);}
  private async record(id:string){updateId.parse(id);const installed=await this.installed();const directory=path.join(installed.config.stateDir,'updates',id);const record=await json(path.join(directory,'journal.json')) as RecordData;if(record.schema!==1||record.id!==id||record.installationId!==installed.config.id)throw new PilotError('update_not_owned');return {installed,directory,record};}
  async check(){
    if(!this.root)return {installKind:'source',automaticInstallation:false,code:'source_installation_requires_manual_update'};
    const installed=await this.installed(),trust=await json(path.join(installed.version,'release-trust.json'));
    const disabled=installed.config.policy==='off'||process.env.TABORA_UPDATE_CHECK==='0';
    return {installKind:installed.config.installKind,channel:installed.config.channel,policy:installed.config.policy,automaticInstallation:!disabled&&trust.keys.length>0&&installed.config.policy==='idle-auto',remoteInstallationAvailable:!disabled&&trust.keys.length>0,code:disabled?'update_checks_disabled':trust.keys.length?undefined:'release_trust_not_configured',current:installed.config.current,steps:['Finish active work. Inspect the outcome of any uncertain browser write before repeating it.','Use browser_update_prepare, then poll browser_update_status until staged.','Call browser_update_apply with its exact update ID and ticket. The updater waits for idle profiles.','Poll status after reconnect. Complete any required browser consent; reconnect MCP to load the new server code.','Source-to-package or extension-ID migrations require explicit installation review; do not overwrite a checkout or browser profile.']};
  }
  async prepare(){
    if(process.env.TABORA_UPDATE_CHECK==='0')throw new PilotError('update_checks_disabled');
    const installed=await this.installed();if(this.pending)throw new PilotError('update_prepare_in_progress');
    if(installed.config.policy==='off')throw new PilotError('update_checks_disabled');
    try{await lstat(path.join(installed.root,'update.lock'));throw new PilotError('update_already_applying');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const trust=await json(path.join(installed.version,'release-trust.json'));if(!trust.keys.length)throw new PilotError('release_trust_not_configured');
    const id=randomUUID(),ticket=randomUUID(),directory=path.join(installed.config.stateDir,'updates',id);
    await mkdir(directory,{recursive:true});
    const record:RecordData={schema:1,installationId:installed.config.id,id,status:'downloading',source:'remote',ticketHash:createHash('sha256').update(ticket).digest('hex'),createdAt:Date.now()};
    await atomicJson(path.join(directory,'journal.json'),record);
    this.pending=(async()=>{
      let phase='metadata';
      try {
        const build=await json(path.join(installed.version,'dist/build-info.json'));
        let base=repository+'/releases/latest/download/';
        if(installed.config.channel==='preview'){
          const advisory=await new UpdateChecker(build,installed.config.stateDir,this.request,Date.now,'preview').check(true);
          if(!advisory.releaseTag||advisory.source==='main')throw new Error('published_release_unavailable');
          base=repository+'/releases/download/'+advisory.releaseTag+'/';
        }
        const bytes=await download(base+'release-manifest.json',undefined,{maximum:65536,request:this.request}) as Buffer;
        const signature=await download(base+'release-manifest.sig',undefined,{maximum:256,request:this.request}) as Buffer;
        const manifest=releaseManifest(bytes,signature,trust,{version:build.version,sequence:installed.config.sequence,contract:build.contractVersion,channel:installed.config.channel});
        if(manifest.extensionId!==installed.config.extensionId)throw new Error('extension_identity_migration_required');
        phase='payload_download';
        const artifact=manifest.artifacts.find((item:any)=>item.kind==='payload'),archive=path.join(directory,'payload.zip');
        await download(artifact.url,archive,{maximum:artifact.size,size:artifact.size,sha256:artifact.sha256,request:this.request});
        phase='extraction';const payload=path.join(directory,'payload');await extract(archive,payload);
        phase='inventory';
        const validated=await validatePayload(payload);if(validated.info.version!==manifest.version||validated.extensionId!==manifest.extensionId||validated.channel!==manifest.channel)throw new Error('release_payload_mismatch');
        const nextTrust=await json(path.join(payload,'release-trust.json'));if(!Array.isArray(nextTrust.keys)||!nextTrust.keys.length)throw new Error('release_trust_rotation_invalid');
        await atomicJson(path.join(directory,'manifest.json'),manifest);
        await atomicJson(path.join(directory,'journal.json'),{...record,status:'staged',manifest,versionId:validated.id});
      }catch(error){const cause=(error as NodeJS.ErrnoException).code;await atomicJson(path.join(directory,'journal.json'),{...record,status:'verification_failed',phase,code:/^[a-z_]+$/.test((error as Error).message)?(error as Error).message:'update_prepare_failed',cause:cause&&/^[A-Z_0-9]{1,50}$/.test(cause)?cause:undefined});}
    })().catch(()=>{this.failures.add(id);while(this.failures.size>20)this.failures.delete(this.failures.values().next().value!);}).finally(()=>{this.pending=undefined;});
    return {updateId:id,ticket,status:'downloading'};
  }
  async status(id:string){const {record}=await this.record(id);const {ticketHash,manifest,previousConfig,...safe}=record as RecordData&{previousConfig?:unknown};return {...safe,...(this.failures.has(id)?{status:'recovery_required',code:'update_journal_write_failed'}:{}),latestVersion:manifest?.version,components:record.status==='mcp_restart_required'?{host:'verified',extension:(record as any).extensionVerified?'verified':'awaiting_profile',mcp:'reconnect_required'}:undefined};}
  async apply(id:string,ticket:string){
    const {installed,directory,record}=await this.record(id);
    const candidate=createHash('sha256').update(z.string().uuid().parse(ticket)).digest();
    if(!timingSafeEqual(candidate,Buffer.from(record.ticketHash,'hex')))throw new PilotError('invalid_update_ticket');
    if(!['staged','waiting_for_other_update'].includes(record.status))throw new PilotError('update_not_staged');
    if(installed.config.policy==='off'&&record.source!=='local-installer')throw new PilotError('update_checks_disabled');
    const current=await json(path.join(installed.version,'dist/build-info.json'));
    if(compare(record.manifest.version,current.version)<=0||record.source!=='local-installer'&&record.manifest.sequence<=installed.config.sequence)throw new PilotError('release_replay_or_downgrade');
    if(record.source!=='local-installer'&&installed.config.channel==='stable'&&record.manifest.channel!=='stable')throw new PilotError('release_channel_changed');
    // The worker owns durable progress after this broker or MCP connection exits.
    await atomicJson(path.join(directory,'journal.json'),{...record,status:'scheduled'});
    const child=spawn(process.execPath,[path.join(installed.version,'dist/host/update-worker.js'),'apply-worker',id],{env:{...process.env,TABORA_INSTALL_ROOT:installed.root,TABORA_STATE_DIR:installed.config.stateDir},detached:true,windowsHide:true,stdio:'ignore'});
    child.on('error',()=>{void atomicJson(path.join(directory,'journal.json'),{...record,status:'recovery_required',code:'updater_launch_failed'}).catch(()=>{this.failures.add(id);});});child.unref();
    return {updateId:id,status:'scheduled',nextStep:'Poll browser_update_status. Do not replay interrupted browser actions.'};
  }
}

/** Admission closes synchronously before waiting for in-flight work. */
export class MaintenanceGate {
  private active=0;
  updateId?:string;
  async run<T>(operation:()=>Promise<T>){if(this.updateId)throw new PilotError('update_maintenance');this.active++;try{return await operation();}finally{this.active--;}}
  begin(id:string){updateId.parse(id);if(this.updateId&&this.updateId!==id)throw new PilotError('update_already_applying');this.updateId=id;return this.active===0;}
  get idle(){return this.active===0;}
  resume(id:string){if(this.updateId!==id)throw new PilotError('update_not_owned');this.updateId=undefined;}
}
