import { randomUUID } from 'node:crypto';
import { PilotError, imageDecisionCapability, type BrowserProfile } from '../shared.js';
import { toolDefinitions, workflowFileSchema, type BrowserTool } from '../browser-api.js';
import {RunController} from './run-controller.js';
import {ArtifactStore,type FileScope} from './artifacts.js';
import {fileCommands} from '../file-contract.js';
import {readDocument} from './documents.js';
import {redactImage,imagePreview} from './image-redaction.js';
import {InteractiveQueue,interactiveCommands} from './interactive-queue.js';
type Connection={profile:BrowserProfile;call:(command:string,payload?:unknown)=>Promise<any>};
type Session={id:string;profileId:string;name:string;owner:string};
export class BrokerRouter {
  private input=new InteractiveQueue();
  async execute<T>(command:string,operation:()=>Promise<T>){return interactiveCommands.has(command)?this.input.run(operation):operation();}
  constructor(readonly runs=new RunController(),readonly files?:ArtifactStore){}
  async workflowCall(scope:FileScope,call:Connection['call'],command:string,input:any){
    if(command==='workflow.file'){
      if(!this.files)throw new PilotError('files_unavailable');
      const source=workflowFileSchema.parse(input) as {path?:string;fileRef?:string;name?:string;rootId?:string};let fileRef=source.fileRef;
      if(source.name){
        const roots=this.files.listRoots(scope),root=source.rootId?roots.find(root=>root.id===source.rootId):roots.length===1?roots[0]:undefined;
        if(!root)throw new PilotError('needs_file_access');const matches=[];let cursor=0;
        for(let page=0;page<20;page++){
          const result=await this.files.find(scope,{rootId:root.id,query:source.name,limit:40,cursor});
          if(result.traversalTruncated)throw new PilotError('file_search_limit');matches.push(...result.files.filter(file=>file.name.toLocaleLowerCase()===source.name!.toLocaleLowerCase()));
          if(matches.length>1)throw new PilotError('ambiguous_file');
          if(result.nextCursor===null){if(matches.length!==1)throw new PilotError('file_not_found');fileRef=matches[0].fileRef;break;}
          if(result.nextCursor<=cursor||page===19)throw new PilotError('file_search_limit');cursor=result.nextCursor;
        }
      }
      if(!this.runs.active(scope.profileId,scope.sessionId))throw new PilotError('cancelled');
      const artifact=await this.files.import(scope,{path:source.path,fileRef});
      if(!this.runs.active(scope.profileId,scope.sessionId)){await this.files.release(scope,[artifact.id]);throw new PilotError('cancelled');}return artifact;
    }
    if(command==='workflow.document'){if(!this.files)throw new PilotError('files_unavailable');const payload=toolDefinitions.browser_document_read.schema.omit({sessionId:true}).parse(input);return readDocument(this.files,scope,payload);}
    if(command==='workflow.capture'){
      if(!this.files)throw new PilotError('files_unavailable');
      const check=()=>{if(!this.runs.active(scope.profileId,scope.sessionId))throw new PilotError('cancelled');};
      const payload=toolDefinitions.browser_capture.schema.omit({sessionId:true}).parse(input),captured=await this.captureArtifact(scope,call,payload,check);
      const {bytes}=await this.files.bytes(scope,captured.artifact.id,20000000);
      try{const image=await imagePreview(bytes);check();return {data:image.data,mimeType:image.mimeType,width:image.width,height:image.height,captureId:captured.visual.captureId,targetId:payload.targetId,stateVersion:payload.stateVersion,expiresAt:captured.visual.expiresAt};}
      finally{bytes.fill(0);await this.files.release(scope,[captured.artifact.id]);}
    }
    if(command==='workflow.download'){
      if(!this.files)throw new PilotError('files_unavailable');const payload=toolDefinitions.browser_download.schema.omit({sessionId:true}).parse(input),result=await call('v2.download',{sessionId:scope.sessionId,...payload});
      if(!this.runs.active(scope.profileId,scope.sessionId))throw new PilotError('cancelled');const artifact=await this.files.importBrowserDownload(scope,result.filename,payload.name);
      if(!this.runs.active(scope.profileId,scope.sessionId)){await this.files.release(scope,[artifact.id]);throw new PilotError('cancelled');}return {artifact,state:result.state,origin:result.origin,exportedToProvider:false};
    }
    if(command==='workflow.upload'){
      if(!this.files)throw new PilotError('files_unavailable');const payload=toolDefinitions.browser_upload.schema.omit({sessionId:true}).parse(input),ticket=this.files.ticket(scope,payload.artifactIds);
      try{return await call('files.upload',{sessionId:scope.sessionId,targetId:payload.targetId,stateVersion:payload.stateVersion,...ticket});}finally{this.files.endTicket(ticket.ticket);}
    }
    return call(command,{sessionId:scope.sessionId,...input});
  }
  private async captureArtifact(scope:FileScope,call:Connection['call'],payload:any,check:()=>void){
      if(!this.files)throw new PilotError('files_unavailable');
      check();const result=await call('v2.capture',{sessionId:scope.sessionId,...payload});let transferId:string|undefined,artifactId:string|undefined;
      try{
        check();if(result.base64Length>28000000)throw new PilotError('image_size_limit');
        const chunks:Buffer[]=[];let offset=0;
        try{while(offset<result.base64Length){const chunk=await call('v2.capture_chunk',{sessionId:scope.sessionId,captureId:result.captureId,offset});check();if(chunk.nextOffset<=offset||chunk.nextOffset>result.base64Length||chunk.data.length!==chunk.nextOffset-offset)throw new PilotError('file_transfer_incomplete');chunks.push(Buffer.from(chunk.data,'base64'));offset=chunk.nextOffset;}
          check();
          const raw=Buffer.concat(chunks);let bytes:Buffer|undefined;try{bytes=await redactImage(raw,result.pixelRedaction);const begin=await this.files.begin(scope,{name:'capture.png',size:bytes.length,mime:'image/png'});transferId=begin.transferId;
            for(let offset=0;offset<bytes.length;offset+=begin.chunkBytes)await this.files.chunk(scope,{transferId,offset,data:bytes.subarray(offset,offset+begin.chunkBytes).toString('base64')});
            check();const artifact=await this.files.finish(scope,{transferId});artifactId=artifact.id;check();return {artifact,visual:result.visual,provenance:result.provenance,redactedRegions:result.redactedRegions,exportedToProvider:false};
          }finally{raw.fill(0);bytes?.fill(0);}
        }finally{chunks.forEach(chunk=>chunk.fill(0));}
      }catch(error){if(artifactId||transferId)await this.files.release(scope,[artifactId??transferId!]);throw error;}
      finally{await call('v2.capture_release',{sessionId:scope.sessionId}).catch(()=>{});}
  }
  private connections=new Map<string,Connection>();
  private sessions=new Map<string,Session>();
  register(connection:Connection){if(this.connections.has(connection.profile.id))throw new PilotError('profile_already_connected');const call=connection.call;connection.call=(command,payload)=>this.execute(command,()=>{if(this.connections.get(connection.profile.id)!==connection)throw new PilotError('profile_disconnected');if(!connection.profile.mcpEnabled&&!['session.release','configuration.changed'].includes(command))throw new PilotError('mcp_access_disabled');return call(command,payload);});this.connections.set(connection.profile.id,connection);}
  async invalidateAll(){this.runs.cancelAll();await Promise.allSettled([...this.connections.values()].map(c=>c.call('configuration.changed')));}
  update(profile:BrowserProfile){
    const connection=this.connections.get(profile.id);if(!connection)throw new PilotError('profile_disconnected');
    if(['mode','vaultEnabled','activeProvider','mcpEnabled'].some(key=>(profile as any)[key]!==(connection.profile as any)[key])){this.runs.cancelProfile(profile.id);this.files?.revokeProfile(profile.id);}
    connection.profile=profile;
    if(!profile.mcpEnabled)for(const s of [...this.sessions.values()])if(s.profileId===profile.id){this.sessions.delete(s.id);void connection.call('session.release',{sessionId:s.id}).catch(()=>{});}
  }
  disconnect(profileId:string){this.runs.cancelProfile(profileId);this.files?.revokeProfile(profileId);this.connections.delete(profileId);for(const s of this.sessions.values())if(s.profileId===profileId)this.sessions.delete(s.id);}
  async releaseOwner(owner:string){
    this.runs.cancelOwner(owner);
    this.files?.revokeOwner(owner);
    const sessions=[...this.sessions.values()].filter(s=>s.owner===owner);for(const s of sessions)this.sessions.delete(s.id);
    await Promise.allSettled(sessions.map(s=>this.connections.get(s.profileId)?.call('session.release',{sessionId:s.id})));
  }
  private connection(profileId:string){const c=this.connections.get(profileId);if(!c)throw new PilotError('profile_disconnected');if(!c.profile.mcpEnabled)throw new PilotError('mcp_access_disabled');return c;}
  async call(owner:string,tool:BrowserTool,input:unknown):Promise<any>{
    if(!Object.hasOwn(toolDefinitions,tool))throw new PilotError('unknown_tool');const p:any=toolDefinitions[tool].schema.parse(input);
    if(tool==='browser_profiles')return [...this.connections.values()].filter(c=>c.profile.mcpEnabled).map(c=>c.profile);
    if(tool==='browser_sessions')return [...this.sessions.values()].filter(s=>s.owner===owner).map(({owner,...s})=>s);
    if(tool==='browser_run_status')return this.runs.status(owner,p.runId);
    if(tool==='browser_run_cancel')return this.runs.cancel(owner,p.runId);
    if(tool==='browser_tabs')return this.connection(p.profileId).call('tabs.list');
    const providerCommands:Partial<Record<BrowserTool,string>>={browser_provider_status:'provider.status',browser_provider_models:'provider.catalog',browser_provider_configure:'provider.configure',browser_provider_select:'provider.select'};
    if(providerCommands[tool]){const {profileId,...payload}=p;return this.connection(profileId).call(providerCommands[tool]!,payload);}
    if(tool==='browser_vault_list')return this.connection(p.profileId).call('vault.list');
    if(tool==='browser_session_create'){
      if([...this.sessions.values()].filter(s=>s.owner===owner).length>=20)throw new PilotError('session_limit');
      const c=this.connection(p.profileId),id=randomUUID();this.sessions.set(id,{id,owner,profileId:p.profileId,name:p.name});
      try{
        const result=await c.call('session.create',{id,name:p.name,windowId:p.windowId,allowedOrigins:p.allowedOrigins,allowPopups:p.allowPopups,siteTools:p.siteTools});
        if(!this.sessions.has(id)||this.connections.get(p.profileId)!==c||!c.profile.mcpEnabled){await c.call('session.release',{sessionId:id}).catch(()=>{});throw new PilotError('session_closed');}
        return {...result,profileId:p.profileId};
      }catch(error){this.sessions.delete(id);throw error;}
    }
    const s=this.sessions.get(p.sessionId);if(!s||s.owner!==owner)throw new PilotError('session_not_owned');
    const c=this.connection(s.profileId),{sessionId,...payload}=p;
    if(tool==='browser_capabilities'){
      const result=await c.call('v2.capabilities',{sessionId}),status=await c.call('status',{sessionId}),config=status.configs.find((item:any)=>item.provider===c.profile.activeProvider);
      return {...result,capabilities:{...result.capabilities,vision:config?{...imageDecisionCapability(config),provider:config.provider,model:config.model}:{status:'external_agent',reason:'caller_supplies_vision'}}};
    }
    if(tool==='browser_image_view'){
      if(!this.files)throw new PilotError('files_unavailable');const scope={owner,profileId:s.profileId,sessionId},{bytes,meta}=await this.files.bytes(scope,p.artifactId,20000000);
      try{if(!['image/png','image/jpeg'].includes(meta.mime))throw new PilotError('unsupported_image');const image=await imagePreview(bytes);this.files.assertOwned(scope,p.artifactId);return {image,provenance:{source:'artifact',trust:'untrusted',artifactId:meta.id,sha256:meta.sha256},exportedToCaller:true};}finally{bytes.fill(0);}
    }
    if(tool==='browser_download'){
      if(!this.files)throw new PilotError('files_unavailable');if(this.runs.active(s.profileId,sessionId))throw new PilotError('run_active');
      const result=await c.call('v2.download',{sessionId,...payload});if(this.sessions.get(sessionId)!==s||!c.profile.mcpEnabled)throw new PilotError('session_closed');
      const artifact=await this.files.importBrowserDownload({owner,profileId:s.profileId,sessionId},result.filename,p.name);
      if(this.sessions.get(sessionId)!==s){await this.files.release({owner,profileId:s.profileId,sessionId},[artifact.id]);throw new PilotError('session_closed');}
      return {downloadId:result.downloadId,artifact,state:result.state,origin:result.origin,exportedToProvider:false};
    }
    if(tool==='browser_capture'){
      if(!this.files)throw new PilotError('files_unavailable');if(this.runs.active(s.profileId,sessionId))throw new PilotError('run_active');
      return this.captureArtifact({owner,profileId:s.profileId,sessionId},c.call,payload,()=>{if(this.sessions.get(sessionId)!==s||this.connections.get(s.profileId)!==c||!c.profile.mcpEnabled)throw new PilotError('session_closed');});
    }
    if(tool==='browser_artifact_chunk'){if(!this.files)throw new PilotError('files_unavailable');return this.files.readOwned({owner,profileId:s.profileId,sessionId},p.artifactId,p.offset);}
    if(tool==='browser_document_read'){if(!this.files)throw new PilotError('files_unavailable');return readDocument(this.files,{owner,profileId:s.profileId,sessionId},p);}
    if(tool==='browser_session_release'){this.runs.cancelSession(s.profileId,sessionId);this.files?.revoke({owner,profileId:s.profileId,sessionId});this.sessions.delete(s.id);return c.call('session.release',{sessionId,closeCreatedTabs:p.closeCreatedTabs});}
    if(tool==='browser_cancel'){this.runs.cancelSession(s.profileId,sessionId);this.files?.revoke({owner,profileId:s.profileId,sessionId});}
    if((fileCommands as readonly string[]).includes(tool)){
      if(!this.files)throw new PilotError('files_unavailable');
      const scope:FileScope={owner,profileId:s.profileId,sessionId};
      if(tool==='browser_files_roots')return this.files.listRoots(scope);
      if(tool==='browser_files_find')return this.files.find(scope,p);
      if(tool==='browser_files_import')return this.files.import(scope,p);
      if(tool==='browser_files_begin')return this.files.begin(scope,p);
      if(tool==='browser_files_chunk')return this.files.chunk(scope,p);
      if(tool==='browser_files_finish')return this.files.finish(scope,p);
      if(tool==='browser_files_status')return this.files.status(scope);
      if(tool==='browser_files_release'){const result=await this.files.release(scope,p.artifactIds);await c.call('files.invalidate',{sessionId,artifactIds:p.artifactIds});return result;}
      if(tool==='browser_files_request')return this.files.createRequest(scope,p);
      if(this.runs.active(s.profileId,sessionId))throw new PilotError('run_active');
      if(c.profile.mode==='readonly')throw new PilotError('readonly_mode');
      const upload=this.files.ticket(scope,p.artifactIds);
      try{return await c.call('files.upload',{sessionId,targetId:p.targetId,stateVersion:p.stateVersion,...upload});}
      finally{this.files.endTicket(upload.ticket);}
    }
    if(tool==='browser_run_start'){
      const preferred=c.profile.activeProvider??'agent';
      if(preferred!=='agent'&&p.provider&&p.provider!==preferred)throw new PilotError('provider_preference_mismatch');
      const provider=p.provider??preferred;if(provider==='agent')throw new PilotError('decision_provider_required');
      return this.runs.start(owner,s.profileId,sessionId,provider,p.goal,(command,input)=>this.workflowCall({owner,profileId:s.profileId,sessionId},c.call,command,input),{maxSteps:p.maxSteps,timeoutMs:p.timeoutMs,readonly:c.profile.mode==='readonly',task:p.task,workflow:p.workflow});
    }
    if(tool!=='browser_cancel'&&this.runs.active(s.profileId,sessionId))throw new PilotError('run_active');
    const commands:Partial<Record<BrowserTool,string>>={browser_site_tools:'v2.site_tools',browser_site_call:'v2.site_call',browser_popups:'popups.list',browser_handoff:'v2.handoff',browser_resume:'v2.resume',browser_capabilities:'v2.capabilities',browser_frames:'v2.frames',browser_state:'v2.state',browser_read:'v2.read',browser_plan:'v2.plan',browser_commit:'v2.commit',browser_session_attach:'pin',browser_session_open:'tabs.open',browser_observe:'observe',browser_decide:'decide',browser_prepare:'manual',browser_execute:'execute',browser_step:'step',browser_cancel:'cancel'};
    return c.call(commands[tool]!,{sessionId,...payload});
  }
}
