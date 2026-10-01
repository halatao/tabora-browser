import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, PilotError, safeCode, idSchema, profileSchema } from '../shared.js';
import { NativeDecoder, encodeMessage } from './codec.js';
import { connectBroker } from './broker-client.js';
import { detectBrowserProfiles } from './browser-profiles.js';
const id=(await readFile(path.join(import.meta.dirname,'../../extension-id.txt'),'utf8')).trim();
if(process.argv[2]!==`chrome-extension://${id}/`){process.stderr.write('Unrecognized extension origin.\n');process.exit(1);}
const peer=await connectBroker('extension');let registered=false;
const pending=new Map<string,{resolve:(data:any)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
function send(message:unknown){try{process.stdout.write(encodeMessage(message));}catch{peer.close();process.exit(1);}}
peer.handler=async(command,payload)=>{
  if(command!=='browser'||!registered)throw new PilotError('unknown_command');
  return new Promise((resolve,reject)=>{
    const requestId=randomUUID(),timer=setTimeout(()=>{pending.delete(requestId);reject(new PilotError('browser_timeout'));},120000);
    pending.set(requestId,{resolve,reject,timer});send({event:'browser-command',id:requestId,...payload});
  });
};
peer.onclose=()=>{for(const p of pending.values())clearTimeout(p.timer);process.exit(0);};
const decoder=new NativeDecoder(),seen=new Set<string>();
process.stdin.on('data',data=>{
  try{for(const raw of decoder.push(data)){
    if((raw as any)?.event==='browser-result'){
      const m=z.object({event:z.literal('browser-result'),id:idSchema,ok:z.boolean(),data:z.unknown().optional(),code:z.string().optional()}).strict().parse(raw);
      const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);if(m.ok)p.resolve(m.data);else p.reject(new PilotError(m.code??'browser_error'));}continue;
    }
    const m=z.object({id:idSchema,version:z.literal(PROTOCOL_VERSION),command:z.string().max(40),sessionId:z.string().max(100).default('panel'),payload:z.unknown().optional()}).strict().parse(raw);
    if(seen.has(m.id)){send({id:m.id,ok:false,code:'duplicate_request'});continue;}seen.add(m.id);if(seen.size>2000)seen.delete(seen.values().next().value!);
    const operation=async()=>{
      if(m.command==='hello'){if(registered)throw new PilotError('already_registered');const p=await peer.call('profile.register',profileSchema.parse(m.payload));registered=true;return p;}
      if(!registered)throw new PilotError('profile_required');
      if(m.command==='profile.detect')return detectBrowserProfiles(m.payload);
      if(m.command==='profile.update')return peer.call(m.command,m.payload);
      return peer.call('host',{command:m.command,payload:m.payload,sessionId:m.sessionId});
    };
    void operation().then(data=>send({id:m.id,ok:true,data}),error=>send({id:m.id,ok:false,code:safeCode(error)}));
  }}catch{process.stderr.write('Invalid native message.\n');peer.close();process.exit(1);}
});
process.stdin.on('end',()=>{peer.close();process.exit(0);});
