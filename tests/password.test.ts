import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Vault} from '../src/host/vault.js';
import {HostService} from '../src/host/service.js';
import {BrokerRouter} from '../src/host/broker-router.js';
import {toolDefinitions} from '../src/browser-api.js';

const profile=randomUUID(),otherProfile=randomUUID(),session=randomUUID();
const binding={origin:'https://example.test',documentId:'document-one',tabId:1};
const account={label:'Synthetic',username:'fixture@example.test'};
const prepare={stateVersion:'state',account};
async function fixture(t:any){
  const directory=await mkdtemp(path.join(os.tmpdir(),'tabora-password-'));
  let key:Buffer;const protector={protect:async(b:Buffer)=>{key=Buffer.from(b);return Buffer.from('test-only-key');},unprotect:async()=>Buffer.from(key)};
  const file=path.join(directory,'vault.json'),vault=new Vault(file,protector),service=new HostService(vault,directory);
  t.after(async()=>{await service.close();key?.fill(0);assert.equal(path.dirname(directory),os.tmpdir());await rm(directory,{recursive:true,force:true});});
  await vault.unlock();return {directory,file,vault,protector,service};
}

test('password creation and update are staged, encrypted, opaque and atomic by existing ID',async t=>{
  const {file,vault}=await fixture(t);
  const existing=await vault.put({kind:'website',...account,origin:binding.origin,secret:'SYNTHETIC-OLD',scope:{type:'profile',profileId:profile}},profile);
  assert.equal(JSON.parse(await readFile(file,'utf8')).version,1);
  const change=await vault.preparePassword({credentialId:existing,stateVersion:'state'},profile,session,binding);
  assert.equal(change.credentialId,existing);assert.equal(vault.websiteSecret(existing,binding.origin,profile).password,'SYNTHETIC-OLD');
  await assert.rejects(vault.resolvePassword(change.changeId,profile,session,binding.origin,'confirmed','agent_verified'),{message:'password_change_not_confirmed'});
  const secret=await vault.beginPasswordFill(change.changeId,profile,session,binding,true);
  assert.equal(secret.currentPassword,'SYNTHETIC-OLD');assert.equal(secret.password.length,24);
  for(const pattern of [/[a-z]/,/[A-Z]/,/[0-9]/,/[!@#$%*\-_=+?]/])assert.match(secret.password,pattern);
  assert(!JSON.stringify(change).includes(secret.password));assert(!JSON.stringify(vault.passwordChanges(profile)).includes(secret.password));
  assert(!JSON.stringify(vault.list(profile)).includes(secret.password));assert(!JSON.stringify(vault.redact({echo:secret.password})).includes(secret.password));
  const disk=await readFile(file,'utf8');assert.equal(JSON.parse(disk).version,2);assert(!disk.includes(secret.password));assert(!disk.includes(account.username));
  await vault.passwordFilled(change.changeId,profile,session,binding);
  const saved=await vault.resolvePassword(change.changeId,profile,session,binding.origin,'confirmed','agent_verified');
  assert.equal(saved.confirmationSource,'caller_attestation');assert.equal(vault.list(profile).length,1);assert.equal(vault.websiteSecret(existing,binding.origin,profile).password,secret.password);
  assert.equal((await vault.resolvePassword(change.changeId,profile,session,binding.origin,'confirmed','agent_verified')).status,'saved');
  const created=await vault.preparePassword(prepare,profile,session,binding);
  await vault.beginPasswordFill(created.changeId,profile,session,binding,false);await vault.passwordFilled(created.changeId,profile,session,binding);
  await vault.resolvePassword(created.changeId,profile,session,binding.origin,'confirmed','user_confirmed');assert.equal(vault.list(profile).length,2);
});

test('unknown/rejected result and crash recovery never replace the old password; refill requires inspection',async t=>{
  const {vault,file,protector}=await fixture(t);
  const id=await vault.put({kind:'website',...account,origin:binding.origin,secret:'SYNTHETIC-OLD'},profile);
  const change=await vault.preparePassword({credentialId:id,stateVersion:'state'},profile,session,binding);
  const secret=await vault.beginPasswordFill(change.changeId,profile,session,binding,false);
  vault.lock();const restarted=new Vault(file,protector);t.after(()=>restarted.lock());await restarted.unlock();
  assert.equal(restarted.passwordChanges(profile)[0].status,'unknown');assert.equal(restarted.websiteSecret(id,binding.origin,profile).password,'SYNTHETIC-OLD');
  const nextSession=randomUUID(),nextBinding={...binding,documentId:'document-two'};
  await assert.rejects(restarted.beginPasswordFill(change.changeId,profile,nextSession,nextBinding,false),{message:'password_change_scope_mismatch'});
  await restarted.resumePassword(change.changeId,profile,nextSession,nextBinding);
  await assert.rejects(restarted.beginPasswordFill(change.changeId,profile,nextSession,nextBinding,false),{message:'password_change_requires_inspection'});
  await restarted.resumePassword(change.changeId,profile,nextSession,nextBinding,true);
  assert.equal((await restarted.beginPasswordFill(change.changeId,profile,nextSession,nextBinding,false)).password,secret.password);
  await restarted.resolvePassword(change.changeId,profile,nextSession,binding.origin,'unknown');assert.equal(restarted.websiteSecret(id,binding.origin,profile).password,'SYNTHETIC-OLD');
  await restarted.resolvePassword(change.changeId,profile,nextSession,binding.origin,'rejected');assert.equal(restarted.websiteSecret(id,binding.origin,profile).password,'SYNTHETIC-OLD');
  await assert.rejects(restarted.resolvePassword(change.changeId,profile,nextSession,binding.origin,'confirmed','agent_verified'),{message:'password_change_closed'});
});

test('password grants enforce profile/session/exact HTTPS document, expiry and concurrent credential edits',async t=>{
  const {vault}=await fixture(t);
  const id=await vault.put({kind:'website',...account,origin:binding.origin,secret:'SYNTHETIC-OLD',scope:{type:'profile',profileId:profile}},profile);
  await assert.rejects(vault.preparePassword(prepare,profile,session,{...binding,origin:'http://example.test'}));
  await assert.rejects(vault.preparePassword({credentialId:id,stateVersion:'s'},otherProfile,session,binding));
  const c=await vault.preparePassword({credentialId:id,stateVersion:'s'},profile,session,binding);
  await assert.rejects(vault.preparePassword({credentialId:id,stateVersion:'s'},profile,session,binding),{message:'password_change_active'});
  assert.deepEqual(vault.passwordChanges(otherProfile),[]);
  for(const [p,s,b] of [[otherProfile,session,binding],[profile,'other-session',binding],[profile,session,{...binding,documentId:'other'}],[profile,session,{...binding,origin:'https://example.test.evil.test'}]] as const)await assert.rejects(vault.beginPasswordFill(c.changeId,p,s,b,false),{message:'password_change_scope_mismatch'});
  const now=Date.now;t.mock.method(Date,'now',()=>now()+86400001);
  await assert.rejects(vault.beginPasswordFill(c.changeId,profile,session,binding,false),{message:'password_change_expired'});t.mock.restoreAll();
  await vault.beginPasswordFill(c.changeId,profile,session,binding,false);
  await vault.rescope(id,{type:'shared'},profile);
  await assert.rejects(vault.resolvePassword(c.changeId,profile,session,binding.origin,'confirmed','agent_verified'),{message:'credential_changed'});
  assert.equal(vault.websiteSecret(id,binding.origin,profile).password,'SYNTHETIC-OLD');
});

test('host password channel requires vault grant, binding and enabled profile; MCP schemas reject secret inputs',async t=>{
  const {service}=await fixture(t);
  const call=(command:string,payload:unknown,enabled=true)=>service.handle(profile,session,command,payload,enabled);
  await call('bind',binding);
  await assert.rejects(call('password.prepare',{...prepare,binding}),{message:'vault_locked'});
  await call('vault.unlock',{});
  await assert.rejects(call('password.prepare',{...prepare,binding},false),{message:'vault_disabled'});
  await assert.rejects(call('password.prepare',{...prepare,binding:{...binding,documentId:'stale'}}),{message:'stale_binding'});
  const c=await call('password.prepare',{...prepare,binding});assert.equal(c.status,'prepared');
  assert.throws(()=>toolDefinitions.browser_password_prepare.schema.parse({...prepare,sessionId:session,password:'LEAK'}));
  assert.throws(()=>toolDefinitions.browser_password_resolve.schema.parse({sessionId:session,changeId:c.changeId,stateVersion:'s',outcome:'confirmed'}));
  service.releaseProfile(profile);await assert.rejects(call('password.list',{}),{message:'vault_locked'});
});

test('revoked authorization before atomic rename rolls back the credential and pending status',async t=>{
  const {vault,file}=await fixture(t);
  const c=await vault.preparePassword(prepare,profile,session,binding);await vault.beginPasswordFill(c.changeId,profile,session,binding,false);
  const before=await readFile(file,'utf8');
  await assert.rejects(vault.resolvePassword(c.changeId,profile,session,binding.origin,'confirmed','agent_verified',()=>{assert.equal(vault.list(profile).length,0,'Uncommitted credentials must not be visible to readers');throw Error('authorization_revoked');}),{message:'authorization_revoked'});
  assert.equal(await readFile(file,'utf8'),before);assert.equal(vault.list(profile).length,0);assert.equal(vault.passwordChanges(profile)[0].status,'unknown');
});

test('pending passwords are redacted at the real host decision-provider boundary',async t=>{
  const {service,vault}=await fixture(t);let captured='';
  (service as any).pool={invalidate(){},async close(){},async decide(_scope:any,_config:any,request:any){captured=JSON.stringify(request);return {status:'selected',choiceId:'continue'};}};
  const call=(command:string,payload:unknown)=>service.handle(profile,session,command,payload);
  await call('vault.unlock',{});await call('bind',binding);
  const c=await call('password.prepare',{...prepare,binding});
  const {password}=await call('password.begin',{changeId:c.changeId,stateVersion:'s',passwordTargetId:'r1',binding});
  await call('configure',{provider:'codex-sdk',model:'synthetic',connection:'sdk',timeoutMs:5000});
  await call('decide',{provider:'codex-sdk',request:{requestId:'redaction-test',stateVersion:'state',question:'Echo '+password,context:{text:password},choices:[{id:'continue',description:'Continue '+password},{id:'ask_user',description:'Ask user'}]}});
  assert(!captured.includes(password));assert(captured.includes('[REDACTED]'));assert.equal(vault.list(profile).length,0);
});

test('password MCP operations route only through owned sessions; direct vault writes stay unavailable',async()=>{
  const router=new BrokerRouter(),seen:any[]=[];
  router.register({profile:{id:profile,name:'Synthetic',mcpEnabled:true,mode:'takeover',vaultEnabled:true},call:async(command,payload:any)=>{seen.push({command,payload});return command==='session.create'?{id:payload.id}:{};}});
  const s=await router.call('owner','browser_session_create',{profileId:profile,name:'Password fixture'});
  const input={sessionId:s.id,stateVersion:'s',account};
  await assert.rejects(router.call('foreign','browser_password_prepare',input),{message:'session_not_owned'});
  await router.call('owner','browser_password_prepare',input);assert.equal(seen.at(-1).command,'v2.password.prepare');
  await router.call('owner','browser_password_changes',{profileId:profile});assert.equal(seen.at(-1).command,'password.list');
  assert(!Object.hasOwn(toolDefinitions,'browser_vault_put'));
  await router.releaseOwner('owner');
});
