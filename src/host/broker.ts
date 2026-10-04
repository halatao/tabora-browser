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
import {admitRun} from './run-admission.js';
import {RunController} from './run-controller.js';
import {ArtifactStore,type FileScope} from './artifacts.js';
import {fileBeginSchema,fileChunkSchema,fileFinishSchema} from '../file-contract.js';
import {exportData} from './export-policy.js';
await mkdir(stateDir,{recursive:true,mode:0o700});
const token=randomBytes(32).toString('hex'),osProtector=protector();
const files=new ArtifactStore(stateDir);
const service:HostService=new HostService(new Vault(path.join(stateDir,'vault.json'),osProtector),stateDir,()=>router.invalidateAll()),router=new BrokerRouter(new RunController(value=>service.vault.locked?value:service.vault.redact(value)),files);
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
      const p=z.object({role:z.enum(['extension','mcp']),token:z.string().regex(/^[a-f0-9]{64}$/),fileRoots:z.array(z.string().max(4000)).max(16).default([])}).strict().parse(payload);
      if(!timingSafeEqual(Buffer.from(p.token),Buffer.from(token)))throw new PilotError('authentication_failed');
      if(p.role==='mcp')await files.registerOwner(owner,p.fileRoots);
      role=p.role;clearTimeout(authTimer);return {authenticated:true};
    }
    if(role==='mcp'){
      if(command!=='tool')throw new PilotError('unknown_command');
      const p=z.object({name:z.string(),arguments:z.unknown()}).strict().parse(payload),result=await router.call(owner,p.name as BrowserTool,p.arguments),redact=(value:any)=>service.vault.locked?value:service.vault.redact(value);
      if(p.name==='browser_image_view'){const {image,...metadata}=result;return {...exportData(metadata,redact),image};}if(p.name==='browser_artifact_chunk'){const {data,...metadata}=result;return {...exportData(metadata,redact),data};}return exportData(result,redact);
    }
    if(command==='profile.register'){
      if(profile)throw new PilotError('already_registered');const parsed=profileSchema.parse(payload);
      router.register({profile:parsed,call:(command,payload)=>peer.call('browser',{command,payload})});profile=parsed;return profile;
    }
    if(!profile)throw new PilotError('profile_required');
    if(command==='profile.update'){
      if(payload?.id&&payload.id!==profile.id)throw new PilotError('profile_scope_mismatch');
      if(['mode','vaultEnabled','activeProvider','mcpEnabled'].some(key=>payload?.[key]!==undefined&&payload[key]!== (profile as any)[key]))service.invalidateProfileDecisions(profile.id);
      profile=profileSchema.parse({...profile,...payload,id:profile.id});router.update(profile);return profile;
    }
    if(command!=='host')throw new PilotError('unknown_command');
    const p=z.object({sessionId:z.string().min(1).max(100),command:z.string().max(40),payload:z.unknown().optional()}).strict().parse(payload);
    if(p.command==='files.read'){
      if(!profile.mcpEnabled||profile.mode==='readonly')throw new PilotError('file_access_revoked');
      const input=z.object({ticket:z.string().uuid(),artifactId:z.string().uuid(),offset:z.number().int().nonnegative()}).strict().parse(p.payload);
      return files.readTicket(profile.id,p.sessionId,input.ticket,input.artifactId,input.offset);
    }
    if(p.command.startsWith('files.')){
      const fileInput=z.object({requestId:z.string().uuid().optional()}).passthrough().parse(p.payload??{});
      let scope:FileScope={owner,profileId:profile.id,sessionId:p.sessionId};
      if(fileInput.requestId)scope=files.panelRequest(profile.id,fileInput.requestId).scope;
      if(p.command==='files.requests')return files.listRequests(profile.id);
      if(p.command==='files.begin')return files.begin(scope,fileBeginSchema.parse(p.payload));
      if(p.command==='files.chunk'){const {requestId,...input}=fileInput;return files.chunk(scope,fileChunkSchema.parse(input));}
      if(p.command==='files.finish'){const {requestId,...input}=fileInput;return files.finish(scope,fileFinishSchema.parse(input));}
      if(p.command==='files.fulfill'){const input=z.object({requestId:z.string().uuid(),artifactIds:z.array(z.string().uuid()).min(1).max(20)}).strict().parse(p.payload);return files.completeRequest(scope,input.requestId,input.artifactIds);}
      if(p.command==='files.cancel'){const input=z.object({requestId:z.string().uuid()}).strict().parse(p.payload);return files.cancelRequest(scope,input.requestId);}
      if(p.command==='files.release'){const input=z.object({artifactIds:z.array(z.string().uuid()).min(1).max(20)}).strict().parse(p.payload);return files.release(scope,input.artifactIds);}
      throw new PilotError('unknown_command');
    }
    if(p.command==='run.start'){
      const admitted=admitRun(p.payload,profile.activeProvider,profile.mode==='readonly');
      const profileId=profile.id;
      return router.runs.start(owner,profileId,p.sessionId,admitted.provider,admitted.goal,(command,input)=>router.workflowCall({owner,profileId,sessionId:p.sessionId},(command,payload)=>router.execute(command,()=>peer.call('browser',{source:'controller',command,payload})),command,input),admitted.options);
    }
    if(p.command==='run.status'||p.command==='run.cancel'){
      const input=z.object({runId:z.string().uuid()}).strict().parse(p.payload);
      return p.command==='run.status'?router.runs.status(owner,input.runId):router.runs.cancel(owner,input.runId);
    }
    if(p.command==='cancel'||p.command==='release')router.runs.cancelSession(profile.id,p.sessionId);
    if(['vault.lock','vault.put','vault.remove','vault.scope'].includes(p.command))router.runs.cancelAll();
    if(['vault.put','vault.remove','vault.scope'].includes(p.command))await router.invalidateAll();
    if(profile.vaultEnabled===false&&(p.command.startsWith('vault.')&&p.command!=='vault.lock'||p.command==='credential.use'))throw new PilotError('vault_disabled');
    const assertActive=()=>{if(p.command==='provider.configure'&&!profile?.mcpEnabled)throw new PilotError('mcp_access_disabled');};
    return service.handle(profile.id,p.sessionId,p.command,p.payload,profile.vaultEnabled!==false,assertActive);
  };
});
// An idle broker can keep Chromium's native-host process job alive during close.
// Retain a short reconnect grace, then await owned workers and staging cleanup.
function scheduleIdle(){clearTimeout(idle);if(!peers.size)idle=setTimeout(()=>{server.close(()=>{void Promise.all([service.close(),files.close()]).then(()=>process.exit(0),()=>process.exit(1));});},2000);}
server.on('error',()=>process.exit(1));
server.listen(brokerPipe(),async()=>{
  try{await files.cleanupPreviousRuns();await service.load();await writeFile(path.join(stateDir,'broker-auth.bin'),await osProtector.protect(Buffer.from(token)),{mode:0o600});initialized();scheduleIdle();}
  catch{process.exit(1);}
});
