import type {FileMetadata} from '../file-contract.js';

export type FilePageInput={op:'start'|'chunk'|'seal'|'commit'|'abort';version?:2;transferId:string;origin:string;token:string;targetId:string;files?:FileMetadata[];index?:number;offset?:number;data?:string;accept?:string;multiple?:boolean};

/** Fixed executor serialized in the canonical sensor's ISOLATED world. No path or arbitrary JS. */
export async function fileOperation(input:FilePageInput):Promise<any>{
  type Transfer={id:string;token:string;el:HTMLInputElement;files:FileMetadata[];chunks:Uint8Array[][];offsets:number[];created:number;accept:string;multiple:boolean;sealed?:FileList};
  type FileRegistry={token:string;entries:Map<string,{el:Element;kind?:string;target?:{kind:string}}>;resolve?:(id:string,write:boolean)=>{el:Element;kind?:string;target:{kind:string}}};
  const world=globalThis as typeof globalThis&{__taboraSensor?:{registry:FileRegistry};__taboraFileTransfer?:Transfer};
  try{
    if(input.op==='abort'){if(world.__taboraFileTransfer?.id===input.transferId)world.__taboraFileTransfer=undefined;return {ok:true};}
    const state=world.__taboraSensor?.registry,entry=state?.resolve?.(input.targetId,true);
    const live=()=>world.__taboraSensor?.registry===state;
    if(location.origin!==input.origin||!state||state.token!==input.token||!entry||(entry.kind??entry.target?.kind)!=='file'||!(entry.el instanceof HTMLInputElement)||entry.el.type!=='file')throw new Error('stale_snapshot');
    const el=entry.el;
    if(!el.isConnected)throw new Error('stale_snapshot');
    if(el.disabled||el.matches(':disabled')||el.closest('[inert]'))throw new Error('target_not_ready');
    if(input.op==='start'){
      if(world.__taboraFileTransfer&&Date.now()-world.__taboraFileTransfer.created<60000)throw new Error('file_transfer_busy');
      const files=input.files!;
      if(el.accept!==input.accept||el.multiple!==input.multiple)throw new Error('stale_snapshot');
      if(!files.length||files.length>20||!el.multiple&&files.length>1||files.reduce((n,f)=>n+f.size,0)>100*1024*1024||files.some(f=>f.size>50*1024*1024))throw new Error('file_size_limit');
      const accept=el.accept.split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);
      for(const f of files){if(accept.length&&!accept.some(v=>v.startsWith('.')?f.name.toLowerCase().endsWith(v):v.endsWith('/*')?f.mime.toLowerCase().startsWith(v.slice(0,-1)):f.mime.toLowerCase()===v))throw new Error('file_type_rejected');}
      world.__taboraFileTransfer={id:input.transferId,token:input.token,el,files,chunks:files.map(()=>[]),offsets:files.map(()=>0),created:Date.now(),accept:el.accept,multiple:el.multiple};
      return {ok:true};
    }
    const t=world.__taboraFileTransfer;
    if(!t||t.id!==input.transferId||t.token!==input.token||t.el!==el||t.accept!==el.accept||t.multiple!==el.multiple||Date.now()-t.created>60000)throw new Error('file_transfer_expired');
    if(input.op==='chunk'){
      const index=input.index!,offset=input.offset!;
      if(!Number.isInteger(index)||index<0||index>=t.files.length||t.offsets[index]!==offset||!input.data||input.data.length>43692)throw new Error('invalid_file_chunk');
      const raw=atob(input.data),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
      if(bytes.length>32768||bytes.length+offset>t.files[index].size)throw new Error('invalid_file_chunk');
      t.chunks[index].push(bytes);t.offsets[index]+=bytes.length;return {ok:true,offset:t.offsets[index]};
    }
    if(t.files.some((f,i)=>t.offsets[i]!==f.size))throw new Error('file_transfer_incomplete');
    if(input.op==='seal'){
    const transfer=new DataTransfer();
    for(let i=0;i<t.files.length;i++){
      const f=t.files[i],blob=new Blob(t.chunks[i] as BlobPart[],{type:f.mime});
      transfer.items.add(new File([blob],f.name,{type:f.mime}));
    }
    if(!live()||world.__taboraFileTransfer!==t)throw new Error('stale_snapshot');
    t.sealed=transfer.files;t.chunks=[];return {ok:true,sealed:true};
    }
    if(!t.sealed)throw new Error('file_transfer_incomplete');
    // Revalidate immediately before the single dispatch. Hashing is owned by the secure worker.
    if(!live()||world.__taboraFileTransfer!==t||!el.isConnected||el.disabled||el.matches(':disabled')||el.closest('[inert]')||el.accept!==t.accept||el.multiple!==t.multiple||location.origin!==input.origin)throw new Error('stale_snapshot');
    world.__taboraFileTransfer=undefined;state.entries.delete(input.targetId);
    el.files=t.sealed;
    el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));
    return {ok:true,dispatch:'sent',attachmentState:'selected',businessOutcomeVerified:false,files:t.files.map(({id,name,size,sha256})=>({id,name,size,sha256}))};
  }catch(error){world.__taboraFileTransfer=undefined;return {ok:false,code:error instanceof Error?(error.message==='stale_reference'?'stale_snapshot':error.message):'file_operation_failed'};}
}
