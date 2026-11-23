import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,stat,rm} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {z} from 'zod';
import {PilotError,idSchema} from '../shared.js';
import {atomicWrite,type KeyProtector} from './vault.js';

const identitySchema=z.object({logonId:z.string().regex(/^S-1-5-5-\d+-\d+$/),bootId:z.string().regex(/^\d{16,20}$/)}).strict();
const grantSchema=z.object({version:z.literal(1),sessionId:z.string().regex(/^[a-f0-9]{64}$/),profileId:idSchema}).strict();
export async function windowsSessionIdentity(script=path.join(import.meta.dirname,'windows-session.ps1')){
  if(process.platform!=='win32')throw new PilotError('windows_required');
  try{
    const exe=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const {stdout}=await promisify(execFile)(exe,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,timeout:10000,maxBuffer:4096});
    const value=identitySchema.parse(JSON.parse(stdout));
    return createHash('sha256').update(JSON.stringify([value.logonId,value.bootId])).digest('hex');
  }catch{throw new PilotError('vault_session_unavailable');}
}

// This records explicit consent, never a password or the vault encryption key.
export class VaultSessionGrants{
  private identity?:Promise<string>;
  constructor(private directory:string,private protector:KeyProtector,private identify=windowsSessionIdentity){}
  private session(){return this.identity??=this.identify().then(value=>z.string().regex(/^[a-f0-9]{64}$/).parse(value)).catch(error=>{this.identity=undefined;throw error;});}
  private file(profileId:string){return path.join(this.directory,idSchema.parse(profileId)+'.bin');}
  async allowed(profileId:string){
    let plaintext:Buffer|undefined;
    try{
      const file=this.file(profileId);if((await stat(file)).size>16384)return false;
      const encrypted=Buffer.from(await readFile(file,'utf8'),'base64');plaintext=await this.protector.unprotect(encrypted);
      const grant=grantSchema.parse(JSON.parse(plaintext.toString('utf8')));
      return grant.profileId===profileId&&grant.sessionId===await this.session();
    }catch{return false;}finally{plaintext?.fill(0);}
  }
  async remember(profileId:string,assertActive:()=>void=()=>{}){
    const sessionId=await this.session(),plaintext=Buffer.from(JSON.stringify(grantSchema.parse({version:1,profileId,sessionId})));
    try{const encrypted=await this.protector.protect(plaintext);await atomicWrite(this.file(profileId),encrypted.toString('base64'),assertActive);}
    catch(error){if(error instanceof PilotError)throw error;throw new PilotError('vault_session_save_failed');}
    finally{plaintext.fill(0);}
  }
  async revoke(profileId:string){try{await rm(this.file(profileId),{force:true});}catch{throw new PilotError('vault_session_revoke_failed');}}
}
