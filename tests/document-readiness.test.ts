import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForTab} from '../src/extension/readiness.js';

test('document readiness does not wait for subresources, and never accepts the previous navigation document',async()=>{
  const previous=(globalThis as any).chrome;
  const listeners=new Set<Function>();let tab:any={id:7,status:'loading',url:'https://fixture.test/new',pendingUrl:'https://fixture.test/new'},href='https://fixture.test/old',injections=0;
  const event={addListener:(fn:Function)=>listeners.add(fn),removeListener:(fn:Function)=>listeners.delete(fn)};
  (globalThis as any).chrome={tabs:{get:async()=>({...tab}),onUpdated:event,onRemoved:event},scripting:{executeScript:async()=>{injections++;return [{result:{ready:true,href}}];}}};
  try{
    const started=Date.now();let resolved=false;const waiting=waitForTab(7,1000,true).then(()=>{resolved=true;});
    await new Promise(r=>setTimeout(r,125));assert.equal(resolved,false);
    href=tab.url;await waiting;assert.equal(tab.status,'loading');assert(Date.now()-started<900);assert(injections>=2);assert.equal(listeners.size,0);
    tab={...tab,pendingUrl:'https://fixture.test/next'};injections=0;
    await assert.rejects(waitForTab(7,150,true),/readiness_timeout/);assert.equal(injections,0);assert.equal(listeners.size,0);
  }finally{(globalThis as any).chrome=previous;}
});

test('denied DOM readiness does not grant script access or pretend loading succeeded',async()=>{
  const previous=(globalThis as any).chrome;const listeners=new Set<Function>();
  const event={addListener:(fn:Function)=>listeners.add(fn),removeListener:(fn:Function)=>listeners.delete(fn)};
  (globalThis as any).chrome={tabs:{get:async()=>({status:'loading',url:'https://denied.test/'}),onUpdated:event,onRemoved:event},scripting:{executeScript:async()=>{throw Error('permission denied');}}};
  try{await assert.rejects(waitForTab(7,150,true),/readiness_timeout/);assert.equal(listeners.size,0);}finally{(globalThis as any).chrome=previous;}
});
