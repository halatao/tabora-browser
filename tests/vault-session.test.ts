import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {Vault,type KeyProtector} from '../src/host/vault.js';
import {HostService} from '../src/host/service.js';
import {VaultSessionGrants,windowsSessionIdentity} from '../src/host/vault-session.js';
import {PilotError} from '../src/shared.js';

async function fixture(t:any){
  const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'vault-session-'));
  const keys=new Map<string,Buffer>();
  const protector:KeyProtector={protect:async value=>{const handle=randomBytes(16);keys.set(handle.toString('hex'),Buffer.from(value));return handle;},unprotect:async handle=>{const key=keys.get(handle.toString('hex'));if(!key)throw Error('invalid_ciphertext');return Buffer.from(key);}};
  const services:HostService[]=[];
  const create=(identity='a'.repeat(64))=>{
    const vault=new Vault(path.join(directory,'vault.json'),protector),grants=new VaultSessionGrants(path.join(directory,'vault-unlocks'),protector,async()=>identity);
    const service=new HostService(vault,directory,async()=>{},grants);services.push(service);return {vault,service,grants};
  };
  t.after(async()=>{for(const service of services)await service.close();for(const key of keys.values())key.fill(0);assert.equal(path.dirname(directory),base);await rm(directory,{recursive:true,force:true});});
  return {directory,protector,create};
}

test('vault and per-profile grants do not expire during long idle periods',async t=>{
  const f=await fixture(t),{service,vault}=f.create(),a=randomUUID(),b=randomUUID();
  await service.handle(a,'panel','vault.unlock',{});
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});t.mock.timers.tick(3*86400000);
  assert.equal(vault.locked,false);assert.equal((await service.handle(a,'panel','status',{})).locked,false);
  assert.equal((await service.handle(b,'panel','status',{})).locked,true);
  await service.handle(a,'panel','vault.lock',{});assert.equal(vault.locked,true);t.mock.timers.reset();
});

test('same Windows session restores only explicitly unlocked profile after host restart; bindings never survive',async t=>{
  const f=await fixture(t),a=randomUUID(),b=randomUUID(),first=f.create(),binding={tabId:1,documentId:'old-document',origin:'https://fixture.test'};
  await first.service.handle(a,'panel','vault.unlock',{});await first.service.handle(a,'task','bind',binding);
  const id=await first.vault.put({kind:'website',label:'Synthetic',origin:binding.origin,username:'synthetic',secret:'SYNTHETIC-ONLY',scope:{type:'profile',profileId:a}},a);
  first.service.releaseProfile(a);assert.equal(first.vault.locked,true);
  assert.equal(await first.service.restoreProfileUnlock(a),true);
  await assert.rejects(first.service.handle(a,'task','credential.use',{id,binding}),{message:'stale_binding'});
  await first.service.close();const restarted=f.create();
  assert.equal((await restarted.service.handle(a,'panel','status',{})).locked,true);
  assert.equal(await restarted.service.restoreProfileUnlock(a),true);assert.equal(await restarted.service.restoreProfileUnlock(b),false);
  assert.equal((await restarted.service.handle(a,'panel','status',{})).vaultUnlockLifetime,'windows_session');
  assert.equal(restarted.vault.websiteSecret(id,binding.origin,a).password,'SYNTHETIC-ONLY');
  const consent=await readFile(path.join(f.directory,'vault-unlocks',a+'.bin'),'utf8');assert(!consent.includes(a));assert(!consent.includes('SYNTHETIC-ONLY'));
});

test('manual lock and disabling vault revoke remembered consent across restart, independently per profile',async t=>{
  const f=await fixture(t),first=f.create(),a=randomUUID(),b=randomUUID();
  await first.service.handle(a,'panel','vault.unlock',{});await first.service.handle(b,'panel','vault.unlock',{});
  await first.service.handle(a,'panel','vault.lock',{});assert.equal((await first.service.handle(b,'panel','status',{})).locked,false);
  await first.service.close();const second=f.create();
  assert.equal(await second.service.restoreProfileUnlock(a),false);assert.equal(await second.service.restoreProfileUnlock(b),true);
  await second.service.revokeProfileUnlock(b);await second.service.close();
  const third=f.create();assert.equal(await third.service.restoreProfileUnlock(b),false);assert.equal(third.vault.locked,true);
});

test('new logon, new boot, copied profile consent and corrupted ciphertext fail closed',async t=>{
  const f=await fixture(t),a=randomUUID(),b=randomUUID(),first=f.create();await first.service.handle(a,'panel','vault.unlock',{});await first.service.close();
  for(const identity of ['b'.repeat(64),'c'.repeat(64)]){const next=f.create(identity);assert.equal(await next.service.restoreProfileUnlock(a),false);assert.equal(next.vault.locked,true);}
  const file=path.join(f.directory,'vault-unlocks',a+'.bin');await copyFile(file,path.join(f.directory,'vault-unlocks',b+'.bin'));
  assert.equal(await f.create().service.restoreProfileUnlock(b),false);
  await writeFile(file,'invalid');assert.equal(await f.create().service.restoreProfileUnlock(a),false);
});

test('unavailable Windows identity does not silently grant persistent unlock',async t=>{
  const f=await fixture(t),vault=new Vault(path.join(f.directory,'separate.json'),f.protector);
  const grants=new VaultSessionGrants(path.join(f.directory,'vault-unlocks'),f.protector,async()=>{throw new PilotError('vault_session_unavailable');});
  const service=new HostService(vault,f.directory,async()=>{},grants);t.after(()=>service.close());const a=randomUUID();
  await assert.rejects(service.handle(a,'panel','vault.unlock',{}),{message:'vault_session_unavailable'});assert.equal(vault.locked,true);
  assert.equal(await service.restoreProfileUnlock(a),false);
});

test('revoked consent cannot be persisted by an unlock interrupted at commit',async t=>{
  const f=await fixture(t),first=f.create(),a=randomUUID();let active=true;
  await assert.rejects(first.grants.remember(a,()=>{active=false;throw new PilotError('profile_disconnected');}),{message:'profile_disconnected'});
  assert.equal(active,false);assert.equal(await first.grants.allowed(a),false);assert.equal(await first.service.restoreProfileUnlock(a),false);
});

test('failed consent persistence or revocation never reports a successful unlock or lock',async t=>{
  const f=await fixture(t),first=f.create(),a=randomUUID();
  const remember=t.mock.method(first.grants,'remember',async()=>{throw new PilotError('vault_session_save_failed');});
  await assert.rejects(first.service.handle(a,'panel','vault.unlock',{}),{message:'vault_session_save_failed'});assert.equal(first.vault.locked,true);
  remember.mock.restore();await first.service.handle(a,'panel','vault.unlock',{});
  const revoke=t.mock.method(first.grants,'revoke',async()=>{throw new PilotError('vault_session_revoke_failed');});
  await assert.rejects(first.service.handle(a,'panel','vault.lock',{}),{message:'vault_session_revoke_failed'});
  assert.equal((await first.service.handle(a,'panel','status',{})).locked,false);
  revoke.mock.restore();await first.service.handle(a,'panel','vault.lock',{});assert.equal(await first.grants.allowed(a),false);assert.equal(first.vault.locked,true);
});

test('Windows session identity is stable across helper processes in the same logon', {skip:process.platform!=='win32'},async()=>{
  const script=path.resolve('scripts/windows-session.ps1'),a=await windowsSessionIdentity(script),b=await windowsSessionIdentity(script);
  assert.match(a,/^[a-f0-9]{64}$/);assert.equal(a,b);
});
