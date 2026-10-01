import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { DpapiProtector } from './vault.js';
import { connectPipe, type Peer } from './ipc.js';
import { PilotError } from '../shared.js';

export const stateDir=path.resolve(process.env.TABORA_STATE_DIR??path.join(process.env.LOCALAPPDATA??'','TaboraBrowser'));
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
        const child=spawn(process.execPath,[path.join(import.meta.dirname,'broker.js')],{env:process.env,windowsHide:true,detached:true,stdio:'ignore'});
        child.on('error',()=>{});child.unref();
      }
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }
  if(!peer)throw new PilotError('broker_unavailable');
  try{
    await peer.call('ready',undefined,15000);
    // DPAPI binds the local routing credential to the Windows user; no TCP listener.
    const wrapped=await readFile(path.join(stateDir,'broker-auth.bin'));
    const bytes=await protector().unprotect(wrapped);
    let token:string;try{token=z.string().regex(/^[a-f0-9]{64}$/).parse(bytes.toString());}finally{bytes.fill(0);}
    await peer.call('authenticate',{role,token},15000);return peer;
  }catch(error){peer.close();throw error;}
}
