import {PilotError} from '../shared.js';
/** Exact bounded reader pagination shared by raw goals and typed workflows. */
export async function readAll(call:(command:string,payload?:unknown)=>Promise<any>,request:Record<string,unknown>){
  const chunks:any[]=[];let offset=0,revision:string|undefined,budget=0;
  for(let part=0;part<100;part++){
    const result=await call('v2.read',{...request,offset,limit:16000,revision});budget+=JSON.stringify(result).length;if(budget>1200000)throw new PilotError('reader_size_limit');
    if(revision&&revision!==result.revision||chunks[0]&&chunks[0].provenance.documentToken!==result.provenance.documentToken)throw new PilotError('reader_changed');revision=result.revision;chunks.push(result);
    if(result.nextOffset===null){if(!result.complete||result.truncated)throw new PilotError('incomplete_dataset');return {...result,text:chunks.map(chunk=>chunk.text??'').join(''),rows:chunks.flatMap(chunk=>chunk.rows??[]),records:chunks.flatMap(chunk=>chunk.records??[]),options:chunks.flatMap(chunk=>chunk.options??[])};}
    if(!Number.isInteger(result.nextOffset)||result.nextOffset<=offset)throw new PilotError('reader_no_progress');offset=result.nextOffset;
  }throw new PilotError('reader_size_limit');
}
