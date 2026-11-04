import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { DpapiProtector } from './vault.js';
import { connectPipe, type Peer } from './ipc.js';
import { PilotError } from '../shared.js';
import { resolveStateDirectory } from '../../scripts/state-directory.mjs';
import {configuredFileRoots} from './file-roots.js';
import {buildInfo} from '../build-info.js';
import {installation} from '../../scripts/distribution/installation.mjs';

export const stateDir=resolveStateDirectory(process.env,path.join(import.meta.dirname,'../../dist/native-host/state.json'));
export function brokerPipe(directory=stateDir){
  const key=createHash('sha256').update(directory.toLowerCase()).digest('hex').slice(0,32);
  return process.platform==='win32'?`\\\\.\\pipe\\tabora-browser-${key}`:path.join(directory,'broker.sock');
}
export function protector(){return new DpapiProtector(path.join(import.meta.dirname,'dpapi.ps1'));}
export async function connectBroker(role:'extension'|'mcp'):Promise<Peer>{
  let started=false,peer:Peer|undefined;
  for(let attempt=0;attempt<100;attempt++){
    try{peer=await connectPipe(brokerPipe());break;}
    catch{
      if(!started){
        started=true;
        const active=process.env.TABORA_INSTALL_ROOT?await installation(process.env.TABORA_INSTALL_ROOT):undefined;
        const child=spawn(active?path.join(active.version,'runtime/node.exe'):process.execPath,[active?path.join(active.version,'dist/host/broker.js'):path.join(import.meta.dirname,'broker.js')],{env:process.env,windowsHide:true,detached:true,stdio:'ignore'});
        child.on('error',()=>{});child.unref();
      }
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }
  if(!peer)throw new PilotError('broker_unavailable');
  try{
    const ready=await peer.call('ready',undefined,15000);
    peer.capabilities={profileMetadataVersion:ready?.profileMetadataVersion===1?1:undefined,updateLifecycleVersion:ready?.updateLifecycleVersion===1?1:undefined};
    // DPAPI binds the local routing credential to the Windows user; no TCP listener.
    const wrapped=await readFile(path.join(stateDir,'broker-auth.bin'));
    const bytes=await protector().unprotect(wrapped);
    let token:string;try{token=z.string().regex(/^[a-f0-9]{64}$/).parse(bytes.toString());}finally{bytes.fill(0);}
    const fileRoots=role==='mcp'?configuredFileRoots(process.env,process.cwd()):[];
    // Legacy source brokers reject additional authentication fields.
    await peer.call('authenticate',{role,token,fileRoots,...(process.env.TABORA_INSTALL_ROOT&&peer.capabilities.profileMetadataVersion===1?{fingerprint:buildInfo.fingerprint}:{})},15000);return peer;
  }catch(error){peer.close();throw error;}
}
