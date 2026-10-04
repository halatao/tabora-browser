import path from 'node:path';
import {constants} from 'node:fs';
import {mkdir,lstat,realpath,open,rm,opendir} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import type {Hash} from 'node:crypto';
import {PilotError} from '../shared.js';
import {FILE_CHUNK_BYTES,FILE_MAX_BYTES,FILE_BATCH_BYTES,FILE_TTL_MS,fileNameSchema,type FileMetadata} from '../file-contract.js';

export type FileScope={owner:string;profileId:string;sessionId:string};
type Artifact={scope:FileScope;file:string;meta:FileMetadata;ready:boolean;handle?:FileHandle;offset:number;hash:Hash;busy:boolean;requestId?:string};
type Root={id:string;path:string};
type FileRef={scope:FileScope;path:string;expires:number};
type Ticket={scope:FileScope;ids:string[];expires:number};
type Request={id:string;scope:FileScope;purpose:string;accept:string;multiple:boolean;state:'waiting_for_user'|'ready'|'cancelled';artifactIds:string[];expiresAt:number};
const same=(a:FileScope,b:FileScope)=>a.owner===b.owner&&a.profileId===b.profileId&&a.sessionId===b.sessionId;
const mimeFor=(name:string)=>({'.pdf':'application/pdf','.txt':'text/plain','.csv':'text/csv','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'}[path.extname(name).toLowerCase()]??'application/octet-stream');
const inside=(root:string,file:string)=>{const relative=path.relative(root,file);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};

/** Local authenticated clients configure roots at connection, never in model tool arguments. */
export class ArtifactStore {
  private roots=new Map<string,Root[]>();
  private artifacts=new Map<string,Artifact>();
  private refs=new Map<string,FileRef>();
  private tickets=new Map<string,Ticket>();
  private requests=new Map<string,Request>();
  private epochs=new Map<string,number>();
  private scopes=new Map<string,FileScope>();
  private directory:string;
  private timer:ReturnType<typeof setInterval>;
  constructor(directory:string){
    this.directory=path.resolve(directory,'artifacts',randomUUID());
    this.timer=setInterval(()=>{void this.sweep().catch(()=>{});},30000);this.timer.unref();
  }
  /** Call only after this broker has acquired its exclusive named-pipe listener. */
  async cleanupPreviousRuns(){
    const base=path.dirname(this.directory);await mkdir(base,{recursive:true,mode:0o700});
    if((await lstat(base)).isSymbolicLink()||await realpath(base)!==base)throw new PilotError('file_staging_path_changed');
    const entries=await opendir(base);
    for await(const entry of entries){
      if(!entry.isDirectory()||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(entry.name))continue;
      const target=path.resolve(base,entry.name);
      if(target===this.directory)continue;
      if(path.dirname(target)!==base||(await lstat(target)).isSymbolicLink()||await realpath(target)!==target)throw new PilotError('file_staging_path_changed');
      await rm(target,{recursive:true,force:true,maxRetries:3});
    }
  }
  private key(s:FileScope){return JSON.stringify([s.owner,s.profileId,s.sessionId]);}
  private epoch(s:FileScope){this.scopes.set(this.key(s),s);return this.epochs.get(this.key(s))??0;}
  private current(s:FileScope,epoch:number){if(this.epoch(s)!==epoch)throw new PilotError('file_access_revoked');}
  async registerOwner(owner:string,paths:string[]){
    if(paths.length>16)throw new PilotError('file_root_limit');
    const roots:Root[]=[];
    for(const value of paths){
      if(!path.isAbsolute(value)||value.startsWith('\\\\')||value.startsWith('//'))throw new PilotError('invalid_file_root');
      const canonical=await realpath(value),stat=await lstat(canonical);
      if(!stat.isDirectory())throw new PilotError('invalid_file_root');
      if(!roots.some(r=>r.path===canonical))roots.push({id:randomUUID(),path:canonical});
    }
    this.roots.set(owner,roots);
  }
  listRoots(s:FileScope){this.epoch(s);return (this.roots.get(s.owner)??[]).map(r=>({id:r.id,name:path.basename(r.path),path:r.path}));}
  private async checkedPath(s:FileScope,value:string){
    if(!path.isAbsolute(value)||value.startsWith('\\\\')||value.startsWith('//')||value.includes('\0'))throw new PilotError('needs_file_access');
    const roots=this.roots.get(s.owner)??[],absolute=path.resolve(value);
    const root=roots.find(r=>inside(r.path,absolute));if(!root)throw new PilotError('needs_file_access');
    await this.validateRoot(root);
    // Refuse reparse/symlink components rather than allow a junction to widen a grant.
    let current=root.path;
    for(const part of path.relative(root.path,absolute).split(path.sep)){
      if(process.platform==='win32'&&(part.includes(':')||/[. ]$/.test(part)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)))throw new PilotError('invalid_file_path');
      current=path.join(current,part);if((await lstat(current)).isSymbolicLink())throw new PilotError('file_path_escape');
    }
    const canonical=await realpath(absolute);if(!inside(root.path,canonical))throw new PilotError('file_path_escape');
    return canonical;
  }
  private async validateRoot(root:Root){if((await lstat(root.path)).isSymbolicLink()||await realpath(root.path)!==root.path)throw new PilotError('file_root_changed');}
  async find(s:FileScope,input:{rootId:string;query:string;limit:number;cursor:number}){
    const epoch=this.epoch(s),root=(this.roots.get(s.owner)??[]).find(r=>r.id===input.rootId);
    if(!root)throw new PilotError('needs_file_access');
    await this.validateRoot(root);
    const queue=[root.path],results:{fileRef:string;name:string;size:number;modifiedAt:number}[]=[];let visited=0,matched=0,complete=true,traversalTruncated=false;
    while(queue.length){
      const dir=queue.shift()!;if(dir!==root.path){await this.checkedPath(s,dir);}
      const entries=[];const handle=await opendir(dir);
      for await(const entry of handle){if(entries.length>=5000-visited){traversalTruncated=true;complete=false;break;}entries.push(entry);}
      entries.sort((a,b)=>a.name.localeCompare(b.name));
      for(const entry of entries){
        this.current(s,epoch);if(++visited>5000){complete=false;traversalTruncated=true;queue.length=0;break;}
        if(entry.isSymbolicLink())continue;const file=path.join(dir,entry.name);
        if(entry.isDirectory()){if(queue.length<1000)queue.push(file);else{complete=false;traversalTruncated=true;}continue;}
        if(!entry.isFile()||!entry.name.toLocaleLowerCase().includes(input.query.toLocaleLowerCase()))continue;
        const checked=await this.checkedPath(s,file),stat=await lstat(checked);this.current(s,epoch);
        if(stat.size>FILE_MAX_BYTES)continue;
        if(matched++<input.cursor)continue;
        if(results.length>=input.limit){complete=false;queue.length=0;break;}
        if(this.refs.size>=5000)throw new PilotError('file_reference_limit');
        const fileRef=randomUUID();this.refs.set(fileRef,{scope:s,path:checked,expires:Date.now()+FILE_TTL_MS});
        results.push({fileRef,name:entry.name,size:stat.size,modifiedAt:stat.mtimeMs});
      }
    }
    return {files:results,complete,visited,traversalTruncated,nextCursor:complete||traversalTruncated?null:input.cursor+results.length};
  }
  async begin(s:FileScope,input:{name:string;size:number;mime:string;requestId?:string}){
    const epoch=this.epoch(s);fileNameSchema.parse(input.name);
    if(input.size>FILE_MAX_BYTES||input.size<0)throw new PilotError('file_size_limit');
    const owned=[...this.artifacts.values()].filter(a=>same(a.scope,s));
    if(owned.length>=20||this.artifacts.size>=200||owned.reduce((sum,a)=>sum+a.meta.size,0)+input.size>FILE_BATCH_BYTES)throw new PilotError('file_quota');
    if(input.requestId){const r=this.request(s,input.requestId);if(r.state!=='waiting_for_user'||!r.multiple&&owned.some(a=>a.requestId===input.requestId))throw new PilotError('file_request_closed');}
    const id=randomUUID(),file=path.join(this.directory,id);
    const a:Artifact={scope:s,file,meta:{id,name:input.name,size:input.size,mime:input.mime,sha256:'',expiresAt:Date.now()+FILE_TTL_MS},ready:false,offset:0,hash:createHash('sha256'),busy:true,requestId:input.requestId};
    this.artifacts.set(id,a);
    try{await mkdir(this.directory,{recursive:true,mode:0o700});a.handle=await open(file,'wx',0o600);this.current(s,epoch);a.busy=false;return {transferId:id,chunkBytes:FILE_CHUNK_BYTES};}
    catch(error){await this.remove(id);await a.handle?.close().catch(()=>{});await rm(file,{force:true});throw error;}
  }
  private artifact(s:FileScope,id:string,ready=false){const a=this.artifacts.get(id);if(!a||!same(a.scope,s)||a.meta.expiresAt<=Date.now())throw new PilotError('file_not_owned');if(ready&&!a.ready)throw new PilotError('file_not_ready');return a;}
  async chunk(s:FileScope,input:{transferId:string;offset:number;data:string}){
    const a=this.artifact(s,input.transferId),epoch=this.epoch(s);
    if(a.ready||a.busy)throw new PilotError('file_transfer_busy');
    const bytes=Buffer.from(input.data,'base64');
    if(!bytes.length||bytes.length>FILE_CHUNK_BYTES||bytes.toString('base64')!==input.data||input.offset!==a.offset||a.offset+bytes.length>a.meta.size)throw new PilotError('invalid_file_chunk');
    a.busy=true;
    try{let written=0;while(written<bytes.length){const result=await a.handle!.write(bytes,written,bytes.length-written,a.offset+written);if(!result.bytesWritten)throw new PilotError('file_write_failed');written+=result.bytesWritten;}this.current(s,epoch);a.hash.update(bytes);a.offset+=bytes.length;return {offset:a.offset};}
    catch(error){await this.remove(a.meta.id);throw error;}finally{a.busy=false;bytes.fill(0);}
  }
  async finish(s:FileScope,input:{transferId:string;sha256?:string}){
    const a=this.artifact(s,input.transferId),epoch=this.epoch(s);if(a.ready)return a.meta;
    if(a.busy||a.offset!==a.meta.size)throw new PilotError('file_transfer_incomplete');a.busy=true;
    try{const digest=a.hash.digest('hex');if(input.sha256&&digest!==input.sha256)throw new PilotError('file_hash_mismatch');await a.handle!.sync();await a.handle!.close();a.handle=undefined;this.current(s,epoch);a.meta.sha256=digest;a.ready=true;return {...a.meta};}
    catch(error){await this.remove(a.meta.id);throw error;}finally{a.busy=false;}
  }
  async import(s:FileScope,input:{path?:string;fileRef?:string}){
    const epoch=this.epoch(s);let value=input.path;
    if(input.fileRef){const ref=this.refs.get(input.fileRef);if(!ref||!same(ref.scope,s)||ref.expires<=Date.now())throw new PilotError('file_not_owned');value=ref.path;}
    if(!value)throw new PilotError('invalid_request');const file=await this.checkedPath(s,value);this.current(s,epoch);
    return this.snapshotPath(s,file,()=>this.checkedPath(s,file));
  }
  /** Only the trusted extension's completed, task-owned Chrome download may call this path. */
  async importBrowserDownload(s:FileScope,filename:string,name?:string){
    if(!path.isAbsolute(filename)||filename.startsWith('\\\\')||filename.startsWith('//'))throw new PilotError('invalid_download_path');
    const file=path.resolve(filename),directory=path.dirname(file);fileNameSchema.parse(path.basename(file));
    const validate=async()=>{if((await lstat(directory)).isSymbolicLink()||await realpath(directory)!==directory||(await lstat(file)).isSymbolicLink()||await realpath(file)!==file)throw new PilotError('download_path_changed');return file;};
    if(name!==undefined)fileNameSchema.parse(name);await validate();return this.snapshotPath(s,file,validate,name);
  }
  private async snapshotPath(s:FileScope,file:string,validate:()=>Promise<string>,name=path.basename(file)){
    const epoch=this.epoch(s);
    const source=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let transferId:string|undefined;
    try{
      const before=await source.stat({bigint:true}),afterOpen=await lstat(await validate(),{bigint:true});
      // libuv reports st_dev=0 for Windows path stats, but a volume ID for handle stats.
      const sameFile=(stat:typeof before)=>before.ino===stat.ino&&(process.platform==='win32'||before.dev===stat.dev)&&before.ctimeNs===stat.ctimeNs;
      if(!before.isFile()||!sameFile(afterOpen))throw new PilotError('file_path_changed');
      if(before.size>BigInt(FILE_MAX_BYTES))throw new PilotError('file_size_limit');this.current(s,epoch);const size=Number(before.size);
      transferId=(await this.begin(s,{name,size,mime:mimeFor(name)})).transferId;
      const bytes=Buffer.alloc(FILE_CHUNK_BYTES);let offset=0;
      try{while(offset<size){const {bytesRead}=await source.read(bytes,0,Math.min(bytes.length,size-offset),offset);if(!bytesRead)throw new PilotError('file_source_changed');await this.chunk(s,{transferId,offset,data:bytes.subarray(0,bytesRead).toString('base64')});offset+=bytesRead;}}finally{bytes.fill(0);}
      const after=await source.stat({bigint:true}),afterPath=await lstat(await validate(),{bigint:true});
      if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||!sameFile(after)||!sameFile(afterPath))throw new PilotError('file_source_changed');this.current(s,epoch);
      return await this.finish(s,{transferId});
    }catch(error){if(transferId)await this.remove(transferId);throw error;}finally{await source.close();}
  }
  status(s:FileScope){return {files:[...this.artifacts.values()].filter(a=>same(a.scope,s)&&a.meta.expiresAt>Date.now()).map(a=>({...a.meta,state:a.ready?'ready':'staging',receivedBytes:a.offset})),requests:[...this.requests.values()].filter(r=>same(r.scope,s)&&r.expiresAt>Date.now()).map(({scope,...r})=>r)};}
  createRequest(s:FileScope,input:{purpose:string;accept:string;multiple:boolean}){this.epoch(s);if(this.requests.size>=200||[...this.requests.values()].filter(r=>same(r.scope,s)).length>=20)throw new PilotError('file_request_limit');const id=randomUUID();this.requests.set(id,{id,scope:s,...input,state:'waiting_for_user',artifactIds:[],expiresAt:Date.now()+FILE_TTL_MS});return {requestId:id,state:'waiting_for_user'};}
  private request(s:FileScope,id:string){const r=this.requests.get(id);if(!r||!same(s,r.scope)||r.expiresAt<Date.now())throw new PilotError('file_request_not_owned');return r;}
  listRequests(profileId:string){return [...this.requests.values()].filter(r=>r.scope.profileId===profileId&&r.state==='waiting_for_user'&&r.expiresAt>Date.now()).map(({scope,...r})=>({...r,sessionId:scope.sessionId}));}
  panelRequest(profileId:string,id:string){const r=this.requests.get(id);if(!r||r.scope.profileId!==profileId||r.state!=='waiting_for_user'||r.expiresAt<Date.now())throw new PilotError('file_request_not_owned');return r;}
  completeRequest(s:FileScope,id:string,ids:string[]){const r=this.request(s,id);if(r.state!=='waiting_for_user'||!r.multiple&&ids.length!==1)throw new PilotError('file_request_closed');ids.forEach(id=>this.artifact(s,id,true));r.artifactIds=ids;r.state='ready';return {state:r.state};}
  async cancelRequest(s:FileScope,id:string){const r=this.request(s,id);r.state='cancelled';await Promise.all([...this.artifacts].filter(([,a])=>same(s,a.scope)&&a.requestId===id).map(([artifactId])=>this.remove(artifactId)));return {state:r.state};}
  ticket(s:FileScope,ids:string[]){if(this.tickets.size>=200)throw new PilotError('file_ticket_limit');const files=ids.map(id=>this.artifact(s,id,true).meta);if(new Set(ids).size!==ids.length)throw new PilotError('duplicate_file');const ticket=randomUUID();this.tickets.set(ticket,{scope:s,ids,expires:Date.now()+60000});return {ticket,files};}
  async readTicket(profileId:string,sessionId:string,ticket:string,id:string,offset:number){
    const t=this.tickets.get(ticket);if(!t||t.scope.profileId!==profileId||t.scope.sessionId!==sessionId||t.expires<Date.now()||!t.ids.includes(id))throw new PilotError('file_ticket_invalid');
    const a=this.artifact(t.scope,id,true),epoch=this.epoch(t.scope);if(offset<0||offset>a.meta.size)throw new PilotError('invalid_file_chunk');
    const f=await open(a.file,'r'),bytes=Buffer.alloc(Math.min(FILE_CHUNK_BYTES,a.meta.size-offset));
    try{const {bytesRead}=await f.read(bytes,0,bytes.length,offset);this.current(t.scope,epoch);if(this.tickets.get(ticket)!==t||!this.artifacts.has(id))throw new PilotError('file_access_revoked');return {data:bytes.subarray(0,bytesRead).toString('base64'),offset,nextOffset:offset+bytesRead,eof:offset+bytesRead===a.meta.size};}finally{bytes.fill(0);await f.close();}
  }
  endTicket(ticket:string){this.tickets.delete(ticket);}
  async readOwned(s:FileScope,id:string,offset:number){const {ticket,files}=this.ticket(s,[id]);try{return {...await this.readTicket(s.profileId,s.sessionId,ticket,id,offset),artifact:files[0]};}finally{this.endTicket(ticket);}}
  async bytes(s:FileScope,id:string,maxBytes=20000000){
    const meta=this.artifact(s,id,true).meta;if(meta.size>maxBytes)throw new PilotError('document_size_limit');
    const {ticket}=this.ticket(s,[id]),chunks:Buffer[]=[];
    try{let offset=0;while(offset<meta.size){const chunk=await this.readTicket(s.profileId,s.sessionId,ticket,id,offset);if(chunk.nextOffset<=offset)throw new PilotError('file_transfer_incomplete');chunks.push(Buffer.from(chunk.data,'base64'));offset=chunk.nextOffset;}return {bytes:Buffer.concat(chunks),meta:{...meta}};}
    finally{this.endTicket(ticket);chunks.forEach(chunk=>chunk.fill(0));}
  }
  assertOwned(s:FileScope,id:string){this.artifact(s,id,true);}
  async release(s:FileScope,ids:string[]){for(const id of ids){const a=this.artifacts.get(id);if(a&&!same(a.scope,s))throw new PilotError('file_not_owned');}await Promise.all(ids.map(id=>this.remove(id)));return {released:true};}
  private async remove(id:string){const a=this.artifacts.get(id);if(!a)return;this.artifacts.delete(id);for(const [key,t] of this.tickets)if(t.ids.includes(id))this.tickets.delete(key);await a.handle?.close().catch(()=>{});await rm(a.file,{force:true});}
  revoke(s:FileScope){this.epochs.set(this.key(s),this.epoch(s)+1);for(const [id,a] of this.artifacts)if(same(a.scope,s))void this.remove(id).catch(()=>{});for(const [id,r] of this.refs)if(same(r.scope,s))this.refs.delete(id);for(const [id,r] of this.requests)if(same(r.scope,s))this.requests.delete(id);for(const [id,t] of this.tickets)if(same(t.scope,s))this.tickets.delete(id);}
  revokeProfile(profileId:string){[...this.scopes.values()].filter(s=>s.profileId===profileId).forEach(s=>this.revoke(s));}
  revokeOwner(owner:string){this.roots.delete(owner);[...this.scopes.values()].filter(s=>s.owner===owner).forEach(s=>this.revoke(s));}
  private async sweep(){const now=Date.now();for(const [id,a] of this.artifacts)if(a.meta.expiresAt<now)await this.remove(id);for(const [id,r] of this.refs)if(r.expires<now)this.refs.delete(id);for(const [id,r] of this.requests)if(r.expiresAt<now)this.requests.delete(id);for(const [id,t] of this.tickets)if(t.expires<now)this.tickets.delete(id);}
  async close(){clearInterval(this.timer);for(const s of this.scopes.values())this.epochs.set(this.key(s),this.epoch(s)+1);this.tickets.clear();this.refs.clear();this.requests.clear();this.roots.clear();await Promise.all([...this.artifacts.keys()].map(id=>this.remove(id)));await rm(this.directory,{recursive:true,force:true,maxRetries:3});}
}
