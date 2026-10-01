import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Vault, type KeyProtector } from '../src/host/vault.js';
import { HostService } from '../src/host/service.js';
import { BrokerRouter } from '../src/host/broker-router.js';

async function fixture(){
  const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'profiles-'));
  const keys=new Map<string,Buffer>();const protector:KeyProtector={protect:async value=>{const key=randomBytes(16);keys.set(key.toString('hex'),Buffer.from(value));return key;},unprotect:async key=>Buffer.from(keys.get(key.toString('hex'))!)};
  const vault=new Vault(path.join(directory,'vault.json'),protector);
  return {vault,directory,cleanup:async()=>{vault.lock();assert.equal(path.dirname(directory),base);await rm(directory,{recursive:true,force:true});}};
}
test('vault shares only shared entries, persists profile scopes, and selects private provider override',async()=>{
  const f=await fixture(),a=randomUUID(),b=randomUUID(),scope={type:'profile' as const,profileId:a};
  try{
    await f.vault.unlock();
    const legacy=await f.vault.put({kind:'website',label:'Legacy shared',origin:'https://fixture.test',username:'test',secret:'FAKE-legacy'});
    const privateId=await f.vault.put({kind:'website',label:'Private',origin:'https://fixture.test',username:'test',secret:'FAKE-private',scope},a);
    await f.vault.put({kind:'provider',provider:'codex-sdk',secret:'FAKE-shared-key',scope:{type:'shared'}},a);
    await f.vault.put({kind:'provider',provider:'codex-sdk',secret:'FAKE-private-key',scope},a);
    assert.equal(f.vault.providerSecret('codex-sdk',a),'FAKE-private-key');assert.equal(f.vault.providerSecret('codex-sdk',b),'FAKE-shared-key');
    assert.equal(f.vault.list(a).length,4);assert.equal(f.vault.list(b).length,2);
    assert.equal(f.vault.websiteSecret(legacy,'https://fixture.test',b).password,'FAKE-legacy');
    assert.throws(()=>f.vault.websiteSecret(privateId,'https://fixture.test',b),{message:'credential_scope_mismatch'});
    assert.throws(()=>f.vault.websiteSecret(privateId,'https://evil.test',a),{message:'credential_scope_mismatch'});
    await assert.rejects(f.vault.remove(privateId,b));await assert.rejects(f.vault.rescope(privateId,{type:'shared'},b));
    await assert.rejects(f.vault.put({kind:'provider',provider:'typesafe-jev',secret:'FAKE',scope},b),{message:'profile_scope_mismatch'});
    assert(!JSON.stringify(f.vault.list(a)).includes('FAKE-'));
    f.vault.lock();await f.vault.unlock();assert.equal(f.vault.websiteSecret(privateId,'https://fixture.test',a).password,'FAKE-private');
    await f.vault.rescope(privateId,{type:'shared'},a);assert.equal(f.vault.websiteSecret(privateId,'https://fixture.test',b).password,'FAKE-private');
    await f.vault.rescope(privateId,scope,a);assert(!f.vault.list(b).some(e=>e.id===privateId));
    const privateKey=f.vault.list(a).find(e=>e.kind==='provider'&&e.scope.type==='profile')!;
    await assert.rejects(f.vault.rescope(privateKey.id,{type:'shared'},a),{message:'scope_conflict'});
    await f.vault.remove(privateKey.id,a);assert.equal(f.vault.providerSecret('codex-sdk',a),'FAKE-shared-key');
    assert(!(await readFile(path.join(f.directory,'vault.json'),'utf8')).includes('FAKE'));
  }finally{await f.cleanup();}
});
test('broker vault unlock and binding are scoped to profile and session; writes are serialized',async()=>{
  const f=await fixture(),service=new HostService(f.vault,f.directory),a=randomUUID(),b=randomUUID();
  const call=(profile:string,command:string,payload?:unknown,session='one')=>service.handle(profile,session,command,payload);
  try{
    await call(a,'vault.unlock');assert.equal((await call(b,'status')).locked,true);await assert.rejects(call(b,'vault.list'),{message:'vault_locked'});
    await call(b,'vault.unlock');
    await Promise.all([call(a,'vault.put',{kind:'website',label:'A',origin:'https://fixture.test',username:'test',secret:'FAKE-A',scope:{type:'profile',profileId:a}}),call(b,'vault.put',{kind:'website',label:'B',origin:'https://fixture.test',username:'test',secret:'FAKE-B',scope:{type:'profile',profileId:b}})]);
    const aId=(await call(a,'vault.list'))[0].id,binding={tabId:5,documentId:'doc',origin:'https://fixture.test'};
    await call(a,'bind',binding);await call(b,'bind',binding);
    assert.equal((await call(a,'credential.use',{id:aId,binding})).password,'FAKE-A');
    await assert.rejects(call(b,'credential.use',{id:aId,binding}),{message:'credential_scope_mismatch'});
    await assert.rejects(call(a,'credential.use',{id:aId,binding},'another'),{message:'stale_binding'});
    await call(a,'vault.lock');assert.equal((await call(b,'status')).locked,false);await assert.rejects(call(a,'vault.list'),{message:'vault_locked'});
    await call(a,'vault.unlock');assert.equal((await call(a,'vault.list')).length,1);
  }finally{await f.cleanup();}
});
test('MCP routes to exact profile, enforces connection ownership and revocation',async()=>{
  const router=new BrokerRouter(),a={id:randomUUID(),name:'A',mcpEnabled:true},b={id:randomUUID(),name:'B',mcpEnabled:false};
  const received:any[]=[];
  router.register({profile:a,call:async(command,payload:any)=>{received.push({profile:a.id,command,payload});return {id:payload?.id};}});
  router.register({profile:b,call:async()=>{throw new Error('Must not reach B');}});
  assert.deepEqual(await router.call('first','browser_profiles',{}),[a]);
  await assert.rejects(router.call('first','browser_tabs',{profileId:b.id}),{message:'mcp_access_disabled'});
  const session=await router.call('first','browser_session_create',{profileId:a.id,name:'Research'});
  await router.call('first','browser_session_attach',{sessionId:session.id,tabId:12});assert.equal(received.at(-1).profile,a.id);
  await assert.rejects(router.call('second','browser_session_attach',{sessionId:session.id,tabId:12}),{message:'session_not_owned'});
  await assert.rejects(router.call('first','browser_prepare',{sessionId:session.id,profileId:b.id,recipe:'click',targetId:'e0'}));
  router.update({...a,mcpEnabled:false});await assert.rejects(router.call('first','browser_cancel',{sessionId:session.id}),{message:'session_not_owned'});
  assert.equal(received.at(-1).command,'session.release');
});
test('disconnect during session creation cannot leave a live orphan session',async()=>{
  const router=new BrokerRouter(),profile={id:randomUUID(),name:'A',mcpEnabled:true};let finish:(value:any)=>void=()=>{};let releases=0;
  router.register({profile,call:async(command,payload:any)=>{if(command==='session.create')return new Promise(resolve=>{finish=()=>resolve({id:payload.id});});releases++;return {};}});
  const create=router.call('owner','browser_session_create',{profileId:profile.id,name:'Pending'});
  await router.releaseOwner('owner');finish({});await assert.rejects(create,{message:'session_closed'});
  assert.equal((await router.call('owner','browser_sessions',{})).length,0);assert(releases>=1);
});
test('disconnect during OS unlock cannot restore the profile grant',async()=>{
  const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'unlock-cancel-'));
  let ready:()=>void=()=>{},resume:()=>void=()=>{};const started=new Promise<void>(resolve=>{ready=resolve;}),gate=new Promise<void>(resolve=>{resume=resolve;});
  const protector:KeyProtector={protect:async b=>{ready();await gate;return Buffer.from(b);},unprotect:async b=>Buffer.from(b)};
  const vault=new Vault(path.join(directory,'vault.json'),protector),service=new HostService(vault,directory),profile=randomUUID();
  try{
    const operation=service.handle(profile,'panel','vault.unlock',undefined);await started;service.releaseProfile(profile);resume();
    await assert.rejects(operation,{message:'profile_disconnected'});assert.equal((await service.handle(profile,'panel','status',undefined)).locked,true);assert(vault.locked);
  }finally{vault.lock();assert.equal(path.dirname(directory),base);await rm(directory,{recursive:true,force:true});}
});
