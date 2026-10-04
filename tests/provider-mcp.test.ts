import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {HostService} from '../src/host/service.js';
import {Vault} from '../src/host/vault.js';
import {BrokerRouter} from '../src/host/broker-router.js';
import {PilotError} from '../src/shared.js';

async function fixture(){
  const base=path.resolve('.test-state');await mkdir(base,{recursive:true});
  const directory=await mkdtemp(path.join(base,'provider-mcp-'));
  const vault=new Vault(path.join(directory,'vault.json'),{protect:async b=>Buffer.from(b),unprotect:async b=>Buffer.from(b)});
  let invalidations=0;
  const service=new HostService(vault,directory,async()=>{invalidations++;});
  const savedKey=process.env.TYPESAFE_API_KEY;process.env.TYPESAFE_API_KEY='FAKE-model-catalog-only';
  return {directory,service,vault,invalidations:()=>invalidations,cleanup:async()=>{
    mock.restoreAll();if(savedKey===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=savedKey;
    await service.close();assert.equal(path.dirname(directory),base);await rm(directory,{recursive:true,force:true});
  }};
}
const config={provider:'typesafe-jev',model:'jev-fixture',settingsScope:'host'};

test('Finished-session cleanup is explicit, owner-scoped and forwarded to the extension',async()=>{
  const router=new BrokerRouter(),profile={id:randomUUID(),name:'Cleanup',mcpEnabled:true};
  const received:any[]=[];
  router.register({profile,call:async(command,input)=>{received.push({command,input});return command==='session.create'?{id:(input as {id:string}).id}:{released:true};}});
  const session=await router.call('owner','browser_session_create',{profileId:profile.id,name:'Done'});
  await assert.rejects(router.call('other','browser_session_release',{sessionId:session.id,closeCreatedTabs:true}),{message:'session_not_owned'});
  await router.call('owner','browser_session_release',{sessionId:session.id,closeCreatedTabs:true});
  assert.deepEqual(received.at(-1),{command:'session.release',input:{sessionId:session.id,closeCreatedTabs:true}});
  const handoff=await router.call('owner','browser_session_create',{profileId:profile.id,name:'Handoff'});
  await router.call('owner','browser_session_release',{sessionId:handoff.id});
  assert.equal(received.at(-1).input.closeCreatedTabs,false);
});

test('MCP provider configuration validates catalog and persists shared model without unlocking vault',async()=>{
  const f=await fixture(),profile=randomUUID(),other=randomUUID();let catalogCalls=0;
  mock.method(globalThis,'fetch',async(url:any)=>{assert.equal(url,'https://api.typesafe.ai/v1/models');catalogCalls++;return Response.json({models:[{name:'jev-fixture'},{name:'jev-other'}]});});
  try{
    const status=await f.service.handle(profile,'panel','provider.configure',config,false);
    assert.equal(status.configs.find((c:any)=>c.provider===config.provider).model,'jev-fixture');
    assert.equal(status.configs.find((c:any)=>c.provider===config.provider).connection,'environment');
    assert.equal((await f.service.handle(other,'panel','status',undefined)).configs.find((c:any)=>c.provider===config.provider).model,'jev-fixture');
    assert(f.vault.locked);assert.equal(f.invalidations(),1);assert.equal(catalogCalls,1);
    assert(!JSON.stringify(status).includes('FAKE-'));
    assert(!await readFile(path.join(f.directory,'settings.json'),'utf8').then(s=>s.includes('FAKE-')));
    await f.service.handle(profile,'panel','provider.configure',config,false);
    assert.equal(f.invalidations(),1,'Idempotent configuration does not cancel another run');
    await assert.rejects(f.service.handle(profile,'panel','provider.configure',{...config,model:'invented'},false),{message:'model_not_available'});
    assert.equal(f.invalidations(),1,'Rejected model does not invalidate pending work');
  }finally{await f.cleanup();}
});

test('MCP configure rejects missing host scope, invalid connections, unavailable Decisions and disabled vault',async()=>{
  const f=await fixture(),profile=randomUUID();const fetch=mock.method(globalThis,'fetch',async()=>{throw Error('Unexpected network request');});
  try{
    const {settingsScope,...missingScope}=config;
    await assert.rejects(f.service.handle(profile,'panel','provider.configure',missingScope,false));
    await assert.rejects(f.service.handle(profile,'panel','provider.configure',{...config,connection:'sdk'},false),{message:'invalid_connection'});
    await assert.rejects(f.service.handle(profile,'panel','provider.configure',{...config,connection:'vault'},false),{message:'vault_disabled'});
    await assert.rejects(f.service.handle(profile,'panel','provider.configure',{...config,provider:'openai-decisions'},false),{message:'decisions_preview_unavailable'});
    assert.equal(fetch.mock.callCount(),0);assert.equal(f.invalidations(),0);assert(f.vault.locked);
  }finally{await f.cleanup();}
});

test('MCP revocation during catalog lookup cannot persist a model change',async()=>{
  const f=await fixture(),profile=randomUUID();let active=true,started!:()=>void,finish!:()=>void;
  const ready=new Promise<void>(resolve=>started=resolve),gate=new Promise<void>(resolve=>finish=resolve);
  mock.method(globalThis,'fetch',async()=>{started();await gate;return Response.json({models:[{name:'jev-fixture'}]});});
  try{
    const operation=f.service.handle(profile,'panel','provider.configure',config,false,()=>{if(!active)throw new PilotError('mcp_access_disabled');});
    await ready;active=false;finish();await assert.rejects(operation,{message:'mcp_access_disabled'});
    assert.equal(f.invalidations(),0);assert.equal((await f.service.handle(profile,'panel','status',undefined)).configs.find((c:any)=>c.provider===config.provider).model,'');
  }finally{await f.cleanup();}
});

test('Provider MCP routing targets only enabled profiles and cannot change security settings or pass secrets',async()=>{
  const router=new BrokerRouter(),enabled={id:randomUUID(),name:'A',mcpEnabled:true},disabled={id:randomUUID(),name:'B',mcpEnabled:false};
  const received:any[]=[];
  router.register({profile:enabled,call:async(command,input)=>{received.push({command,input});return {};}});
  router.register({profile:disabled,call:async()=>assert.fail('Disabled profile reached')});
  for(const [tool,command,input] of [
    ['browser_provider_status','provider.status',{}],
    ['browser_provider_models','provider.catalog',{provider:'codex-sdk',connection:'sdk'}],
    ['browser_provider_configure','provider.configure',{...config,timeoutMs:30000}],
    ['browser_provider_select','provider.select',{provider:'agent'}],
  ] as const){
    await router.call('caller',tool,{profileId:enabled.id,...input});assert.equal(received.at(-1).command,command);assert(!('profileId' in received.at(-1).input));
    await assert.rejects(router.call('caller',tool,{profileId:disabled.id,...input}),{message:'mcp_access_disabled'});
  }
  await assert.rejects(router.call('caller','browser_provider_select',{profileId:enabled.id,provider:'agent',vaultEnabled:true}));
  await assert.rejects(router.call('caller','browser_provider_configure',{profileId:enabled.id,...config,secret:'FAKE-never-accepted'}));
  await assert.rejects(router.call('caller','browser_provider_select',{profileId:randomUUID(),provider:'agent'}),{message:'profile_disconnected'});
});
