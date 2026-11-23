import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, randomInt } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, rm, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { PilotError, exactOrigin, vaultEntrySchema, secretScopeSchema, type SecretScope, type VaultInput, type VaultEntry, type VaultMetadata, type ProviderId } from '../shared.js';
import {passwordBindingSchema,passwordPrepareSchema,type PasswordBinding} from '../password-contract.js';

const changeSchema=z.object({
  id:z.string().uuid(),profileId:z.string().uuid(),sessionId:z.string().min(1),binding:passwordBindingSchema,
  credentialId:z.string().uuid(),previousHash:z.string().optional(),value:vaultEntrySchema,
  status:z.enum(['prepared','unknown','filled','rejected','saved']),expiresAt:z.number(),attempted:z.boolean().default(false),
  confirmation:z.enum(['agent_verified','user_confirmed']).optional(),
}).strict();
type PasswordChange=z.infer<typeof changeSchema>;
const entriesSchema=z.array(z.object({id:z.string().uuid(),value:vaultEntrySchema}).strict()).max(200);
const revision=({id,...value}:VaultEntry)=>createHash('sha256').update(JSON.stringify({id,value:vaultEntrySchema.parse(value)})).digest('hex');
const metadata=({id,credentialId,binding,status,expiresAt,confirmation}:PasswordChange)=>({changeId:id,credentialId,origin:binding.origin,status,expiresAt,confirmation,confirmationSource:confirmation?'caller_attestation':undefined});

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
const diskSchema = z.object({ version:z.union([z.literal(1),z.literal(2)]), key:z.string().max(16384), iv:z.string(), tag:z.string(), data:z.string().max(1000000) }).strict();
export async function atomicWrite(file: string, value: string,assertActive:()=>void=()=>{}) {
  await mkdir(path.dirname(file), { recursive:true, mode:0o700 });
  const temp = file + '.' + randomUUID() + '.tmp';
  try { await writeFile(temp,value,{mode:0o600,flag:'wx'}); assertActive(); await rename(temp,file); }
  finally { await rm(temp,{force:true}); }
}
export class Vault {
  private key?: Buffer;
  private wrapped = '';
  private persistedHash?:string;
  private entries: VaultEntry[] = [];
  private changes:PasswordChange[]=[];
  private format:1|2=1;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private file: string, private protector: KeyProtector) {}
  get locked() { return !this.key; }
  private requireKey() {
    if (!this.key) throw new PilotError('vault_locked');
  }
  lock() { this.key?.fill(0); this.key = undefined; this.entries = []; this.changes=[]; }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation); this.tail = run.catch(()=>{}); return run;
  }
  unlock() { return this.serialized(async () => {
    if (this.key) { this.requireKey(); return; }
    let raw: string;
    try { raw = await readFile(this.file,'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.key = randomBytes(32);
      try { this.wrapped = (await this.protector.protect(this.key)).toString('base64'); await this.save(); this.requireKey(); return; }
      catch { this.lock(); throw new PilotError('vault_create_failed'); }
    }
    try {
      const disk = diskSchema.parse(JSON.parse(raw));
      const key = await this.protector.unprotect(Buffer.from(disk.key,'base64'));
      if (key.length !== 32) { key.fill(0); throw new Error('key'); }
      this.key = key;
      const decrypt = createDecipheriv('aes-256-gcm',key,Buffer.from(disk.iv,'base64'));
      decrypt.setAAD(Buffer.from('tabora-browser-vault:v'+disk.version)); decrypt.setAuthTag(Buffer.from(disk.tag,'base64'));
      const plaintext = Buffer.concat([decrypt.update(Buffer.from(disk.data,'base64')),decrypt.final()]);
      try {
        const decoded=JSON.parse(plaintext.toString());
        const envelope=disk.version===1?{entries:entriesSchema.parse(decoded),changes:[]}:z.object({entries:entriesSchema,changes:z.array(changeSchema).max(32)}).strict().parse(decoded);
        const data=envelope.entries;this.changes=envelope.changes;this.format=disk.version;
        this.entries = data.map(e=>({id:e.id,...e.value})); this.wrapped = disk.key;
      } finally { plaintext.fill(0); }
      this.persistedHash=createHash('sha256').update(raw).digest('hex');this.requireKey();
    } catch { this.lock(); throw new PilotError('vault_unlock_failed'); }
  }); }
  private async save(assertActive:()=>void=()=>{},state={entries:this.entries,changes:this.changes,format:this.format}) {
    if (!this.key) throw new PilotError('vault_locked');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm',this.key,iv);
    cipher.setAAD(Buffer.from('tabora-browser-vault:v'+state.format));
    const entries=state.entries.map(({id,...value})=>({id,value}));
    const data = Buffer.from(JSON.stringify(state.format===1?entries:{entries,changes:state.changes}));
    try {
      const encrypted = Buffer.concat([cipher.update(data),cipher.final()]);
      const encoded=JSON.stringify({version:state.format,key:this.wrapped,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')});
      await mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
      let guard;
      try{guard=await open(this.file+'.lock','wx',0o600);}catch{throw new PilotError('vault_busy');}
      try {
        let current:string|undefined;
        try{current=await readFile(this.file,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
        const currentHash=current===undefined?undefined:createHash('sha256').update(current).digest('hex');
        if(currentHash!==this.persistedHash){this.lock();throw new PilotError('vault_changed');}
        await atomicWrite(this.file,encoded,()=>{if(!this.key)throw new PilotError('vault_locked');assertActive();});this.persistedHash=createHash('sha256').update(encoded).digest('hex');
      }finally{await guard.close();await rm(this.file+'.lock',{force:true});}
    } finally { data.fill(0); }
  }
  list(profileId?:string): VaultMetadata[] {
    this.requireKey(); return this.entries.filter(e=>visible(e,profileId)).map(e=>e.kind === 'provider'
      ? {id:e.id,kind:e.kind,label:e.provider,provider:e.provider,scope:e.scope??{type:'shared'}}
      : {id:e.id,kind:e.kind,label:e.label,origin:e.origin,scope:e.scope??{type:'shared'}});
  }
  put(input: VaultInput,profileId?:string) { return this.serialized(async () => {
    this.requireKey(); const parsed = vaultEntrySchema.parse(input);
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
    this.requireKey(); const old = this.entries; this.entries = old.filter(e=>e.id!==id);
    try { await this.save(); } catch(e) { if (!this.locked) this.entries=old; throw e; }
  }); }
  rescope(id:string,scope:SecretScope,profileId:string) { return this.serialized(async()=>{
    this.requireKey();scope=secretScopeSchema.parse(scope);authorizeScope(scope,profileId);
    const entry=this.entries.find(e=>e.id===id);
    if(!entry||!visible(entry,profileId))throw new PilotError('credential_scope_mismatch');
    if(entry.kind==='provider'&&this.entries.some(e=>e.id!==id&&e.kind==='provider'&&e.provider===entry.provider&&sameScope(e.scope,scope)))throw new PilotError('scope_conflict');
    const old=this.entries;this.entries=old.map(e=>e.id===id?{...e,scope}:e);
    try {await this.save();}catch(e){if(!this.locked)this.entries=old;throw e;}
  }); }
  providerSecret(provider: ProviderId,profileId?:string): string {
    this.requireKey(); const candidates=this.entries.filter(e=>e.kind==='provider' && e.provider===provider && visible(e,profileId));
    const entry=candidates.find(e=>e.scope?.type==='profile')??candidates[0];
    if (!entry) throw new PilotError('missing_api_key'); return entry.secret;
  }
  websiteSecret(id: string, origin: string,profileId?:string): { username:string; password:string } {
    this.requireKey(); const e = this.entries.find(e=>e.id===id);
    if (!e || !visible(e,profileId) || e.kind!=='website' || e.origin!==exactOrigin(origin,true)) throw new PilotError('credential_scope_mismatch');
    return {username:e.username,password:e.secret};
  }
  passwordChanges(profileId:string){this.requireKey();return this.changes.filter(c=>c.profileId===profileId).map(metadata);}
  private change(id:string,profileId:string,sessionId?:string,binding?:PasswordBinding){
    this.requireKey();const c=this.changes.find(c=>c.id===id&&c.profileId===profileId);
    if(!c||sessionId!==undefined&&c.sessionId!==sessionId||binding&&(c.binding.origin!==exactOrigin(binding.origin,true)||c.binding.tabId!==binding.tabId||c.binding.documentId!==binding.documentId))throw new PilotError('password_change_scope_mismatch');
    return c;
  }
  private async saveChange(change:PasswordChange,entries=this.entries,assertActive:()=>void=()=>{}){
    let retained=this.changes.filter(c=>c.id!==change.id);
    if(retained.length>=32)retained=retained.filter(c=>!['saved','rejected'].includes(c.status));
    const changes=[...retained,change];await this.save(assertActive,{entries,changes,format:2});
    if(this.locked)throw new PilotError('vault_locked');
    this.changes=changes;this.entries=entries;this.format=2;return metadata(change);
  }
  preparePassword(input:unknown,profileId:string,sessionId:string,binding:PasswordBinding,assertActive:()=>void=()=>{}){return this.serialized(async()=>{
    this.requireKey();const p=passwordPrepareSchema.parse(input);binding=passwordBindingSchema.parse(binding);binding.origin=exactOrigin(binding.origin,true);
    if(this.changes.filter(c=>!['saved','rejected'].includes(c.status)).length>=32)throw new PilotError('password_change_limit');
    const existing=p.credentialId?this.entries.find(e=>e.id===p.credentialId):undefined;
    if(p.credentialId&&(!existing||!visible(existing,profileId)||existing.kind!=='website'||existing.origin!==binding.origin))throw new PilotError('credential_scope_mismatch');
    if(existing&&this.changes.some(c=>c.credentialId===existing.id&&!['saved','rejected'].includes(c.status)))throw new PilotError('password_change_active');
    const groups=['abcdefghijkmnopqrstuvwxyz','ABCDEFGHJKLMNPQRSTUVWXYZ','23456789',...(p.symbols?['!@#$%*-_=+?']:[])],alphabet=groups.join('');
    const chars=groups.map(g=>g[randomInt(g.length)]);while(chars.length<p.length)chars.push(alphabet[randomInt(alphabet.length)]);
    for(let i=chars.length-1;i>0;i--){const j=randomInt(i+1);[chars[i],chars[j]]=[chars[j],chars[i]];}
    const scope=p.account?.scope??{type:'profile' as const,profileId};authorizeScope(scope,profileId);
    const value=vaultEntrySchema.parse(existing?{...(({id,...value})=>value)(existing),secret:chars.join('')}:{kind:'website',...p.account,scope,origin:binding.origin,secret:chars.join('')});
    return this.saveChange({id:randomUUID(),profileId,sessionId,binding,credentialId:existing?.id??randomUUID(),previousHash:existing?revision(existing):undefined,value,status:'prepared',attempted:false,expiresAt:Date.now()+86400000},this.entries,assertActive);
  });}
  resumePassword(id:string,profileId:string,sessionId:string,binding:PasswordBinding,refillAfterInspection=false,assertActive:()=>void=()=>{}){return this.serialized(async()=>{
    const c=this.change(id,profileId);if(c.binding.origin!==exactOrigin(binding.origin,true))throw new PilotError('password_change_scope_mismatch');
    if(c.status==='saved'||c.status==='rejected')throw new PilotError('password_change_closed');
    // Recovery changes the document grant, never the generated password or the old credential.
    return this.saveChange({...c,sessionId,binding,status:refillAfterInspection?'prepared':'unknown',expiresAt:Date.now()+86400000},this.entries,assertActive);
  });}
  beginPasswordFill(id:string,profileId:string,sessionId:string,binding:PasswordBinding,current:boolean,assertActive:()=>void=()=>{}){return this.serialized(async()=>{
    const c=this.change(id,profileId,sessionId,binding);
    if(c.expiresAt<Date.now())throw new PilotError('password_change_expired');
    if(c.status!=='prepared')throw new PilotError('password_change_requires_inspection');
    if(c.previousHash){const entry=this.entries.find(e=>e.id===c.credentialId);if(!entry||revision(entry)!==c.previousHash||!visible(entry,profileId))throw new PilotError('credential_changed');}
    let currentPassword:string|undefined;
    if(current){if(!c.previousHash)throw new PilotError('current_credential_missing');const entry=this.entries.find(e=>e.id===c.credentialId);if(!entry||revision(entry)!==c.previousHash)throw new PilotError('credential_changed');currentPassword=entry.secret;}
    await this.saveChange({...c,status:'unknown',attempted:true},this.entries,assertActive);
    return {password:c.value.secret,currentPassword};
  });}
  passwordFilled(id:string,profileId:string,sessionId:string,binding:PasswordBinding,assertActive:()=>void=()=>{}){return this.serialized(async()=>{
    const c=this.change(id,profileId,sessionId,binding);if(c.status!=='unknown')throw new PilotError('password_change_requires_inspection');return this.saveChange({...c,status:'filled'},this.entries,assertActive);
  });}
  resolvePassword(id:string,profileId:string,sessionId:string,origin:string,outcome:'confirmed'|'rejected'|'unknown',confirmation?:'agent_verified'|'user_confirmed',assertActive:()=>void=()=>{}){return this.serialized(async()=>{
    const c=this.change(id,profileId,sessionId);if(c.binding.origin!==exactOrigin(origin,true))throw new PilotError('password_change_scope_mismatch');
    if(c.status==='saved'){if(outcome!=='confirmed')throw new PilotError('password_change_closed');return metadata(c);}
    if(c.status==='rejected')throw new PilotError('password_change_closed');
    if(outcome!=='confirmed')return this.saveChange({...c,status:outcome},this.entries,assertActive);
    if(!confirmation||!c.attempted||!['filled','unknown'].includes(c.status))throw new PilotError('password_change_not_confirmed');
    if(c.expiresAt<Date.now())throw new PilotError('password_change_expired');
    const existing=this.entries.find(e=>e.id===c.credentialId);
    if(c.previousHash? !existing||revision(existing)!==c.previousHash:!!existing)throw new PilotError('credential_changed');
    if(!existing&&this.entries.length>=200)throw new PilotError('vault_full');
    return this.saveChange({...c,status:'saved',confirmation},[...this.entries.filter(e=>e.id!==c.credentialId),{id:c.credentialId,...c.value}],assertActive);
  });}
  redact<T>(input: T): T {
    this.requireKey();
    const walk=(value:unknown):unknown=>{
      if(typeof value==='string') {for(const secret of [...this.entries.map(e=>e.secret),...this.changes.map(c=>c.value.secret)])value=(value as string).split(secret).join('[REDACTED]');return value;}
      if(Array.isArray(value))return value.map(walk);
      if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,walk(v)]));
      return value;
    };
    return walk(input) as T;
  }
}
