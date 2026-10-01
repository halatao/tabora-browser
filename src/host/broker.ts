import { createServer } from 'node:net';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { Peer } from './ipc.js';
import { brokerPipe, stateDir, protector } from './broker-client.js';
import { Vault } from './vault.js';
import { HostService } from './service.js';
import { BrokerRouter } from './broker-router.js';
import { PilotError, profileSchema, type BrowserProfile } from '../shared.js';
import type { BrowserTool } from '../browser-api.js';
await mkdir(stateDir,{recursive:true,mode:0o700});
const token=randomBytes(32).toString('hex'),osProtector=protector();
const service=new HostService(new Vault(path.join(stateDir,'vault.json'),osProtector),stateDir),router=new BrokerRouter();
const peers=new Set<Peer>();let idle:NodeJS.Timeout;
// Clients can connect before DPAPI finishes, but authentication waits for the new credential.
let initialized:()=>void;const ready=new Promise<void>(resolve=>{initialized=resolve;});
const server=createServer(socket=>{
  if(peers.size>=64){socket.destroy();return;}
  clearTimeout(idle);const peer=new Peer(socket);peers.add(peer);
  let role:'extension'|'mcp'|undefined,profile:BrowserProfile|undefined;
  const owner=randomUUID(),authTimer=setTimeout(()=>peer.close(),20000);
  peer.onclose=()=>{clearTimeout(authTimer);peers.delete(peer);void router.releaseOwner(owner);if(profile){router.disconnect(profile.id);service.releaseProfile(profile.id);}scheduleIdle();};
  peer.handler=async(command,payload)=>{
    await ready;
    if(!role){
      if(command==='ready')return {ready:true};
      if(command!=='authenticate')throw new PilotError('authentication_required');
      const p=z.object({role:z.enum(['extension','mcp']),token:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(payload);
      if(!timingSafeEqual(Buffer.from(p.token),Buffer.from(token)))throw new PilotError('authentication_failed');role=p.role;clearTimeout(authTimer);return {authenticated:true};
    }
    if(role==='mcp'){
      if(command!=='tool')throw new PilotError('unknown_command');
      const p=z.object({name:z.string(),arguments:z.unknown()}).strict().parse(payload);return router.call(owner,p.name as BrowserTool,p.arguments);
    }
    if(command==='profile.register'){
      if(profile)throw new PilotError('already_registered');const parsed=profileSchema.parse(payload);
      router.register({profile:parsed,call:(command,payload)=>peer.call('browser',{command,payload})});profile=parsed;return profile;
    }
    if(!profile)throw new PilotError('profile_required');
    if(command==='profile.update'){
      if(payload?.id&&payload.id!==profile.id)throw new PilotError('profile_scope_mismatch');
      profile=profileSchema.parse({...profile,...payload,id:profile.id});router.update(profile);return profile;
    }
    if(command!=='host')throw new PilotError('unknown_command');
    const p=z.object({sessionId:z.string().min(1).max(100),command:z.string().max(40),payload:z.unknown().optional()}).strict().parse(payload);
    if(profile.vaultEnabled===false&&(p.command.startsWith('vault.')&&p.command!=='vault.lock'||p.command==='credential.use'))throw new PilotError('vault_disabled');
    return service.handle(profile.id,p.sessionId,p.command,p.payload,profile.vaultEnabled!==false);
  };
});
function scheduleIdle(){clearTimeout(idle);if(!peers.size)idle=setTimeout(()=>{service.vault.lock();server.close(()=>process.exit(0));},15000);}
server.on('error',()=>process.exit(1));
server.listen(brokerPipe(),async()=>{
  try{await service.load();await writeFile(path.join(stateDir,'broker-auth.bin'),await osProtector.protect(Buffer.from(token)),{mode:0o600});initialized();scheduleIdle();}
  catch{process.exit(1);}
});
