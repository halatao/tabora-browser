import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,createConnection} from 'node:net';
import {once} from 'node:events';
import {Peer} from '../src/host/ipc.js';
import {PilotError,safeErrorDetails} from '../src/shared.js';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {NativeDecoder,encodeMessage} from '../src/host/codec.js';
import {nativeErrorDetails,nativeErrorData} from '../src/extension/native-errors.js';

test('native diagnostics negotiate the old strict shape until the host advertises expanded fields',()=>{
  const legacy=z.object({targetId:z.string().optional(),blockers:z.array(z.object({tag:z.string(),id:z.string(),className:z.string(),role:z.string(),name:z.string()}).strict())}).strict();
  const details={targetId:'r47',blockers:[],phase:'actionability' as const,cause:'overlay' as const,dispatch:'not_sent' as const};
  const error=new PilotError('target_obscured',undefined,details);
  const downgraded=nativeErrorDetails(error,1);assert(legacy.safeParse(downgraded).success);assert.deepEqual(downgraded,{targetId:'r47',blockers:[]});
  assert.deepEqual(nativeErrorDetails(error,2),details);
});

test('native error envelope remains readable by hosts that reject a top-level details field',()=>{
  const legacy=z.object({event:z.literal('browser-result'),id:z.string().uuid(),ok:z.boolean(),data:z.unknown().optional(),code:z.string().optional()}).strict();
  const error=new PilotError('target_obscured',undefined,{blockers:[],phase:'actionability',dispatch:'not_sent'});
  for(const version of [1,2] as const){const message={event:'browser-result',id:randomUUID(),ok:false,code:error.code,data:nativeErrorData(error,version)},decoded=new NativeDecoder().push(encodeMessage(message));assert.equal(decoded.length,1);assert(legacy.safeParse(decoded[0]).success);assert(!Object.hasOwn(message,'details'));}
});

test('bounded occlusion diagnostics survive broker IPC; unrelated error data is omitted',async()=>{
 const details={targetId:'r47',blockers:[{tag:'DIV',id:'',className:'consent-overlay',role:'generic',name:''}]};
 assert.deepEqual(safeErrorDetails(new PilotError('target_obscured',undefined,details)),details);
 assert.equal(safeErrorDetails(new PilotError('provider_failed','secret',details)),undefined);
 assert.equal(safeErrorDetails(new PilotError('target_obscured',undefined,{...details,password:'secret'} as any)),undefined);
 let peer:Peer|undefined;
 const server=createServer(socket=>{peer=new Peer(socket);peer.handler=async()=>{throw new PilotError('target_obscured',undefined,details);};});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const socket=createConnection({host:'127.0.0.1',port:(server.address() as any).port});await once(socket,'connect');const client=new Peer(socket);
 try{await assert.rejects(client.call('probe'),error=>error instanceof PilotError&&error.code==='target_obscured'&&JSON.stringify(error.details)===JSON.stringify(details));}
 finally{socket.destroy();peer?.socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('legacy strict clients receive the original action error and keep their connection',async()=>{
 const details={targetId:'r171',blockers:[{tag:'DIV',id:'fixed-bottom',className:'select-dates-fixed',role:'generic',name:'Select dates'}]};
 const legacyResponse=z.object({type:z.literal('response'),id:z.string().uuid(),ok:z.boolean(),data:z.unknown().optional(),code:z.string().optional()}).strict();
 let peer:Peer|undefined;
 const server=createServer(socket=>{peer=new Peer(socket);peer.handler=async command=>{if(command==='commit')throw new PilotError('target_obscured',undefined,details);return {sessions:['owned-session']};};});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const socket=createConnection({host:'127.0.0.1',port:(server.address() as any).port});await once(socket,'connect');
 const decoder=new NativeDecoder();
 const request=async(command:string)=>{
   const response=once(socket,'data');socket.write(encodeMessage({type:'request',id:randomUUID(),command}));
   const packets=decoder.push((await response)[0]);assert.equal(packets.length,1);return legacyResponse.parse(packets[0]);
 };
 try{
   const failure=await request('commit');assert.equal(failure.code,'target_obscured');assert.deepEqual(failure.data,{details});
   assert.deepEqual((await request('sessions')).data,{sessions:['owned-session']});assert.equal(socket.destroyed,false);
 }finally{socket.destroy();peer?.socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('malformed IPC response reports protocol failure without exposing its payload',async()=>{
 const server=createServer(socket=>socket.on('data',()=>socket.write(encodeMessage({type:'response',unexpected:'private payload'}))));
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const socket=createConnection({host:'127.0.0.1',port:(server.address() as any).port});await once(socket,'connect');const client=new Peer(socket);
 try{await assert.rejects(client.call('probe'),error=>error instanceof PilotError&&error.code==='ipc_protocol_error'&&error.details===undefined);}
 finally{socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
