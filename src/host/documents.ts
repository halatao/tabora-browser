import {fork} from 'node:child_process';
import path from 'node:path';
import {PilotError} from '../shared.js';
import type {ArtifactStore,FileScope} from './artifacts.js';
let active=0;
const parsed=new WeakMap<ArtifactStore,Map<string,{expires:number;result:any}>>();
function chunk(result:any,input:{offset:number;limit:number;revision?:string}){
  if(input.revision&&input.revision!==result.revision)throw new PilotError('reader_changed');
  const end=Math.min(result.text.length,input.offset+input.limit);
  return {...result,text:result.text.slice(input.offset,end),offset:input.offset,nextOffset:end<result.text.length?end:null,complete:end>=result.text.length,truncated:end<result.text.length};
}
export async function readDocument(store:ArtifactStore,scope:FileScope,input:{artifactId:string;format:'pdf'|'ocr';page:number;ocr:boolean;layout?:boolean;offset:number;limit:number;revision?:string}){
  store.assertOwned(scope,input.artifactId);
  const key=JSON.stringify([scope.owner,scope.profileId,scope.sessionId,input.artifactId,input.format,input.page,input.ocr,!!input.layout]);
  const cache=parsed.get(store)??new Map();parsed.set(store,cache);
  for(const [key,item] of cache)if(item.expires<=Date.now())cache.delete(key);
  const previous=cache.get(key);if(previous)return chunk(previous.result,input);
  if(active>=2)throw new PilotError('document_busy');active++;
  try{
    const {bytes,meta}=await store.bytes(scope,input.artifactId,20000000);
    try{
      if(input.format==='ocr'&&!['image/png','image/jpeg'].includes(meta.mime))throw new PilotError('unsupported_image');
      const worker=fork(path.join(import.meta.dirname,'document-worker.js'),[],{serialization:'advanced',execArgv:['--max-old-space-size=256'],windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],env:Object.fromEntries(['SystemRoot','PATH','TEMP','TMP','LOCALAPPDATA'].flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]!]]))});
      const result=await new Promise<any>((resolve,reject)=>{
        let settled=false;
        const timer=setTimeout(()=>{settled=true;worker.kill();reject(new PilotError('document_timeout'));},30000);
        worker.once('error',()=>{clearTimeout(timer);settled=true;reject(new PilotError('document_parse_failed'));});
        worker.once('exit',()=>{clearTimeout(timer);if(!settled)reject(new PilotError('document_parse_failed'));});
        worker.once('message',(message:any)=>{settled=true;clearTimeout(timer);worker.kill();if(message?.ok&&message.result)resolve(message.result);else reject(new PilotError(typeof message?.code==='string'?message.code:'document_parse_failed'));});
        worker.send({...input,offset:0,revision:undefined,fullText:true,bytes},error=>{if(error&&!settled){settled=true;clearTimeout(timer);worker.kill();reject(new PilotError('document_parse_failed'));}});
      });
      store.assertOwned(scope,input.artifactId);
      const complete={...result,provenance:{source:'artifact',trust:'untrusted',artifactId:meta.id,sha256:meta.sha256,parser:input.format==='pdf'?'pdfjs-dist@6.3.289':'tesseract.js@7.0.0',localOnly:true}};
      if(cache.size>=8)cache.delete(cache.keys().next().value!);cache.set(key,{expires:Date.now()+60000,result:complete});
      return chunk(complete,input);
    }finally{bytes.fill(0);}
  }finally{active--;}
}
