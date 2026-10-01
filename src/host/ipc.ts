import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { NativeDecoder, encodeMessage } from './codec.js';
import { PilotError, safeCode } from '../shared.js';

const packetSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('request'),id:z.string().uuid(),command:z.string().max(60),payload:z.unknown().optional()}).strict(),
  z.object({type:z.literal('response'),id:z.string().uuid(),ok:z.boolean(),data:z.unknown().optional(),code:z.string().optional()}).strict(),
]);
export class Peer {
  handler:(command:string,payload:any)=>Promise<unknown>=async()=>{throw new PilotError('not_ready');};
  onclose:()=>void=()=>{};
  private pending=new Map<string,{resolve:(data:any)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  private active=0;
  constructor(readonly socket:Socket){
    const decoder=new NativeDecoder();
    socket.on('error',()=>socket.destroy());
    socket.on('close',()=>{
      for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new PilotError('connection_lost'));}
      this.pending.clear();this.onclose();
    });
    socket.on('data',data=>{
      try{for(const raw of decoder.push(data)){
        const m=packetSchema.parse(raw);
        if(m.type==='response'){
          const p=this.pending.get(m.id);if(!p)continue;clearTimeout(p.timer);this.pending.delete(m.id);
          if(m.ok)p.resolve(m.data);else p.reject(new PilotError(m.code??'peer_error'));
        }else{
          if(++this.active>128)throw new PilotError('too_many_requests');
          void Promise.resolve().then(()=>this.handler(m.command,m.payload)).then(
            result=>this.send({type:'response',id:m.id,ok:true,data:result}),
            error=>this.send({type:'response',id:m.id,ok:false,code:safeCode(error)}),
          ).finally(()=>this.active--);
        }
      }}catch{socket.destroy();}
    });
  }
  private send(value:unknown){if(this.socket.destroyed)return;try{this.socket.write(encodeMessage(value));}catch{this.socket.destroy();}}
  call(command:string,payload?:unknown,timeoutMs=125000):Promise<any>{
    if(this.socket.destroyed)return Promise.reject(new PilotError('connection_lost'));
    if(this.pending.size>=128)return Promise.reject(new PilotError('too_many_requests'));
    return new Promise((resolve,reject)=>{
      const id=randomUUID(),timer=setTimeout(()=>{this.pending.delete(id);reject(new PilotError('ipc_timeout'));this.socket.destroy();},timeoutMs);
      this.pending.set(id,{resolve,reject,timer});this.send({type:'request',id,command,payload});
    });
  }
  close(){this.socket.destroy();}
}
export function connectPipe(pipe:string):Promise<Peer>{
  return new Promise((resolve,reject)=>{
    const socket=createConnection(pipe);
    const timer=setTimeout(()=>socket.destroy(new Error('connect_timeout')),2000);
    socket.once('error',reject);
    socket.once('connect',()=>{clearTimeout(timer);socket.removeListener('error',reject);resolve(new Peer(socket));});
    socket.once('close',()=>clearTimeout(timer));
  });
}
