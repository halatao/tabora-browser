import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, rm, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { PilotError, exactOrigin, vaultEntrySchema, secretScopeSchema, type SecretScope, type VaultInput, type VaultEntry, type VaultMetadata, type ProviderId } from '../shared.js';

function visible(entry:VaultEntry,profileId?:string) { return entry.scope?.type!=='profile'||entry.scope.profileId===profileId; }
function sameScope(a?:SecretScope,b?:SecretScope) { return (a?.type??'shared')===(b?.type??'shared') && (a?.type!=='profile'||(b?.type==='profile'&&a.profileId===b.profileId)); }
function authorizeScope(scope:SecretScope|undefined,profileId?:string) {
  if(scope?.type==='profile'&&scope.profileId!==profileId)throw new PilotError('profile_scope_mismatch');
}

export interface KeyProtector { protect(value: Buffer): Promise<Buffer>; unprotect(value: Buffer): Promise<Buffer>; }
export class DpapiProtector implements KeyProtector {
  constructor(private script: string) {}
  private run(operation: string, bytes: Buffer): Promise<Buffer> {
    if (process.platform !== 'win32') return Promise.reject(new PilotError('windows_required'));
    return new Promise((resolve, reject) => {
      const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const child = spawn(exe, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',this.script,operation], { windowsHide:true, stdio:['pipe','pipe','pipe'] });
      let output = ''; let finished = false;
      const timer = setTimeout(() => { child.kill(); done(new PilotError('os_key_timeout')); }, 10000);
      function done(error?: Error) { if (finished) return; finished = true; clearTimeout(timer); if (error) reject(error); else resolve(Buffer.from(output.trim(),'base64')); }
      child.on('error', () => done(new PilotError('os_key_failed')));
      child.stdout.on('data', data => { output += data.toString(); if (output.length > 16384) { child.kill(); done(new PilotError('os_key_failed')); } });
      child.stderr.resume();
      child.stdin.on('error', () => done(new PilotError('os_key_failed')));
      child.on('exit', code => done(code === 0 ? undefined : new PilotError('os_key_failed')));
      child.stdin.end(bytes.toString('base64'));
    });
  }
  protect(value: Buffer) { return this.run('protect', value); }
  unprotect(value: Buffer) { return this.run('unprotect', value); }
}
const diskSchema = z.object({ version:z.literal(1), key:z.string().max(16384), iv:z.string(), tag:z.string(), data:z.string().max(1000000) }).strict();
export async function atomicWrite(file: string, value: string) {
  await mkdir(path.dirname(file), { recursive:true, mode:0o700 });
  const temp = file + '.' + randomUUID() + '.tmp';
  try { await writeFile(temp,value,{mode:0o600,flag:'wx'}); await rename(temp,file); }
  finally { await rm(temp,{force:true}); }
}
export class Vault {
  private key?: Buffer;
  private wrapped = '';
  private persistedHash?:string;
  private entries: VaultEntry[] = [];
  private expiry?: NodeJS.Timeout;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private file: string, private protector: KeyProtector, private idleMs = 10 * 60 * 1000) {}
  get locked() { return !this.key; }
  private touch() {
    if (!this.key) throw new PilotError('vault_locked');
    clearTimeout(this.expiry);
    this.expiry = setTimeout(()=>this.lock(),this.idleMs).unref();
  }
  lock() { clearTimeout(this.expiry); this.key?.fill(0); this.key = undefined; this.entries = []; }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation); this.tail = run.catch(()=>{}); return run;
  }
  unlock() { return this.serialized(async () => {
    if (this.key) { this.touch(); return; }
    let raw: string;
    try { raw = await readFile(this.file,'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.key = randomBytes(32);
      try { this.wrapped = (await this.protector.protect(this.key)).toString('base64'); await this.save(); this.touch(); return; }
      catch { this.lock(); throw new PilotError('vault_create_failed'); }
    }
    try {
      const disk = diskSchema.parse(JSON.parse(raw));
      const key = await this.protector.unprotect(Buffer.from(disk.key,'base64'));
      if (key.length !== 32) { key.fill(0); throw new Error('key'); }
      this.key = key;
      const decrypt = createDecipheriv('aes-256-gcm',key,Buffer.from(disk.iv,'base64'));
      decrypt.setAAD(Buffer.from('tabora-browser-vault:v1')); decrypt.setAuthTag(Buffer.from(disk.tag,'base64'));
      const plaintext = Buffer.concat([decrypt.update(Buffer.from(disk.data,'base64')),decrypt.final()]);
      try {
        const data = z.array(z.object({id:z.string().uuid(),value:vaultEntrySchema}).strict()).max(200).parse(JSON.parse(plaintext.toString()));
        this.entries = data.map(e=>({id:e.id,...e.value})); this.wrapped = disk.key;
      } finally { plaintext.fill(0); }
      this.persistedHash=createHash('sha256').update(raw).digest('hex');this.touch();
    } catch { this.lock(); throw new PilotError('vault_unlock_failed'); }
  }); }
  private async save() {
    if (!this.key) throw new PilotError('vault_locked');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm',this.key,iv);
    cipher.setAAD(Buffer.from('tabora-browser-vault:v1'));
    const data = Buffer.from(JSON.stringify(this.entries.map(({id,...value})=>({id,value}))));
    try {
      const encrypted = Buffer.concat([cipher.update(data),cipher.final()]);
      const encoded=JSON.stringify({version:1,key:this.wrapped,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')});
      await mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
      let guard;
      try{guard=await open(this.file+'.lock','wx',0o600);}catch{throw new PilotError('vault_busy');}
      try {
        let current:string|undefined;
        try{current=await readFile(this.file,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
        const currentHash=current===undefined?undefined:createHash('sha256').update(current).digest('hex');
        if(currentHash!==this.persistedHash){this.lock();throw new PilotError('vault_changed');}
        await atomicWrite(this.file,encoded);this.persistedHash=createHash('sha256').update(encoded).digest('hex');
      }finally{await guard.close();await rm(this.file+'.lock',{force:true});}
    } finally { data.fill(0); }
  }
  list(profileId?:string): VaultMetadata[] {
    this.touch(); return this.entries.filter(e=>visible(e,profileId)).map(e=>e.kind === 'provider'
      ? {id:e.id,kind:e.kind,label:e.provider,provider:e.provider,scope:e.scope??{type:'shared'}}
      : {id:e.id,kind:e.kind,label:e.label,origin:e.origin,scope:e.scope??{type:'shared'}});
  }
  put(input: VaultInput,profileId?:string) { return this.serialized(async () => {
    this.touch(); const parsed = vaultEntrySchema.parse(input);
    authorizeScope(parsed.scope,profileId);
    if (parsed.kind === 'website') parsed.origin = exactOrigin(parsed.origin,true);
    const old = this.entries;
    const entry = { ...parsed, id:randomUUID() };
    const retained=old.filter(e=>!(e.kind==='provider' && parsed.kind==='provider' && e.provider===parsed.provider && sameScope(e.scope,parsed.scope)));
    if (retained.length >= 200) throw new PilotError('vault_full');
    this.entries = [...retained,entry];
    try { await this.save(); return entry.id; } catch (e) { if (!this.locked) this.entries = old; throw e; }
  }); }
  remove(id: string,profileId?:string) { return this.serialized(async () => {
    const entry=this.entries.find(e=>e.id===id);
    if(!entry||!visible(entry,profileId))throw new PilotError('credential_scope_mismatch');
    this.touch(); const old = this.entries; this.entries = old.filter(e=>e.id!==id);
    try { await this.save(); } catch(e) { if (!this.locked) this.entries=old; throw e; }
  }); }
  rescope(id:string,scope:SecretScope,profileId:string) { return this.serialized(async()=>{
    this.touch();scope=secretScopeSchema.parse(scope);authorizeScope(scope,profileId);
    const entry=this.entries.find(e=>e.id===id);
    if(!entry||!visible(entry,profileId))throw new PilotError('credential_scope_mismatch');
    if(entry.kind==='provider'&&this.entries.some(e=>e.id!==id&&e.kind==='provider'&&e.provider===entry.provider&&sameScope(e.scope,scope)))throw new PilotError('scope_conflict');
    const old=this.entries;this.entries=old.map(e=>e.id===id?{...e,scope}:e);
    try {await this.save();}catch(e){if(!this.locked)this.entries=old;throw e;}
  }); }
  providerSecret(provider: ProviderId,profileId?:string): string {
    this.touch(); const candidates=this.entries.filter(e=>e.kind==='provider' && e.provider===provider && visible(e,profileId));
    const entry=candidates.find(e=>e.scope?.type==='profile')??candidates[0];
    if (!entry) throw new PilotError('missing_api_key'); return entry.secret;
  }
  websiteSecret(id: string, origin: string,profileId?:string): { username:string; password:string } {
    this.touch(); const e = this.entries.find(e=>e.id===id);
    if (!e || !visible(e,profileId) || e.kind!=='website' || e.origin!==exactOrigin(origin,true)) throw new PilotError('credential_scope_mismatch');
    return {username:e.username,password:e.secret};
  }
  redact<T>(input: T): T {
    this.touch();
    const walk=(value:unknown):unknown=>{
      if(typeof value==='string') {for(const e of this.entries)value=(value as string).split(e.secret).join('[REDACTED]');return value;}
      if(Array.isArray(value))return value.map(walk);
      if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,walk(v)]));
      return value;
    };
    return walk(input) as T;
  }
}
