import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DiagnosticBuffer} from '../src/diagnostic-buffer.js';
import {BrokerRouter} from '../src/host/broker-router.js';
import {PilotError,safeErrorDetails} from '../src/shared.js';

test('diagnostic buffer is bounded, expires and never accepts arbitrary sensitive payloads',()=>{
  let now=0;const buffer=new DiagnosticBuffer(()=>now);
  for(let i=0;i<110;i++)buffer.add('target_obscured',{blockers:[],attempts:i,dispatch:'not_sent'});
  const events=buffer.read();assert.equal(events.length,100);assert.equal(events[0].details.attempts,10);
  events[0].details.attempts=999;assert.equal(buffer.read()[0].details.attempts,10);
  buffer.add('target_obscured',{blockers:[],password:'private'} as any);assert.equal(buffer.read().length,100);
  now=900001;assert.equal(buffer.read().length,0);
  assert(safeErrorDetails(new PilotError('tab_discarded',undefined,{blockers:[],phase:'lifecycle',cause:'discarded',dispatch:'not_sent'})));
});
test('disconnect keeps owner-only interruption evidence without restoring or replaying a session',async()=>{
  const router=new BrokerRouter(),profile={id:randomUUID(),name:'work2',mcpEnabled:true};let calls=0;
  router.register({profile,call:async(command,input:any)=>{calls++;return command==='session.create'?{id:input.id}:{};}});
  const session=await router.call('owner','browser_session_create',{profileId:profile.id,name:'fixture'});router.disconnect(profile.id);
  const records=await router.call('owner','browser_sessions',{});assert.equal(records.length,1);assert.equal(records[0].status,'interrupted');assert.equal(records[0].dispatch,'unknown');
  assert.deepEqual(await router.call('other','browser_sessions',{}),[]);
  await assert.rejects(router.call('other','browser_diagnostics',{sessionId:session.id}),/session_not_owned/);
  const diagnostics=await router.call('owner','browser_diagnostics',{sessionId:session.id});assert.equal(diagnostics.interruption.code,'profile_disconnected');
  router.register({profile,call:async()=>{calls++;return {};}});
  await assert.rejects(router.call('owner','browser_state',{sessionId:session.id}),/session_interrupted/);assert.equal(calls,1);
  await router.releaseOwner('owner');assert.deepEqual(await router.call('owner','browser_sessions',{}),[]);
});

test('multilingual diagnostic export stays below the native messaging byte limit and declares truncation',()=>{
  const buffer=new DiagnosticBuffer();
  for(let i=0;i<100;i++)buffer.add('target_obscured',{blockers:Array.from({length:9},()=>({tag:'DIV',id:'界'.repeat(120),className:'界'.repeat(240),role:'generic',name:'界'.repeat(240)})),attempts:i});
  const result=buffer.snapshot();assert(result.truncated);assert(result.events.length>0);assert(Buffer.byteLength(JSON.stringify(result))<129000);assert.equal(result.events.at(-1)?.details.attempts,99);
});
