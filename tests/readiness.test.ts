import test from 'node:test';
import assert from 'node:assert/strict';
import {withInteractiveTab} from '../src/extension/readiness.js';
import {PilotError} from '../src/shared.js';
import {withTargetDebugger} from '../src/extension/target-debugger.js';

test('background lease validates ownership, never activates windows, and serializes through readiness',async()=>{
  const original=globalThis.chrome,events:string[]=[];
  const fake={permissions:{contains:async()=>false},tabs:{get:async(id:number)=>({id,windowId:10,active:false}),update:async()=>assert.fail('Must not activate tabs')},windows:{get:async()=>({focused:false,state:'minimized'}),update:async()=>assert.fail('Must not focus/restore windows')}};
  Object.defineProperty(globalThis,'chrome',{value:fake,configurable:true});
  let release!:()=>void;const waiting=new Promise<void>(r=>{release=r;});
  try{
    const first=withInteractiveTab(1,async()=>{events.push('validate 1');},async()=>{events.push('start 1');await waiting;events.push('ready 1');});
    const second=withInteractiveTab(2,async()=>{events.push('validate 2');},async()=>{events.push('start 2');});
    while(!events.includes('start 1'))await new Promise(r=>setTimeout(r,1));
    assert(!events.includes('start 2'));assert.equal(events[0],'validate 1');
    release();await Promise.all([first,second]);assert(events.indexOf('ready 1')<events.indexOf('start 2'));
    const before=events.length;
    await assert.rejects(withInteractiveTab(3,async()=>{throw new PilotError('tab_not_permitted');},async()=>{assert.fail('Must not dispatch');}),/tab_not_permitted/);
    assert.equal(events.length,before);
    await withInteractiveTab(4,async()=>{},async()=>{events.push('start 4');});assert(events.includes('start 4'));
  }finally{Object.defineProperty(globalThis,'chrome',{value:original,configurable:true});}
});

test('a timed out waiter does not release another session background lease',async()=>{
  const original=globalThis.chrome,activated:number[]=[];
  Object.defineProperty(globalThis,'chrome',{configurable:true,value:{permissions:{contains:async()=>false},tabs:{get:async(id:number)=>({id,windowId:1,active:false,discarded:false})},windows:{get:async()=>({focused:false,state:'minimized'})}}});
  let release!:()=>void;const waiting=new Promise<void>(r=>{release=r;});
  try{
    const first=withInteractiveTab(1,async()=>{},async()=>{activated.push(1);await waiting;});
    while(!activated.length)await new Promise(r=>setTimeout(r,1));
    await assert.rejects(withInteractiveTab(2,async()=>{},async()=>{activated.push(2);},10),/interaction_busy/);
    const third=withInteractiveTab(3,async()=>{},async()=>{activated.push(3);});
    await new Promise(r=>setTimeout(r,5));assert.deepEqual(activated,[1]);release();await Promise.all([first,third]);assert.deepEqual(activated,[1,3]);
  }finally{Object.defineProperty(globalThis,'chrome',{value:original,configurable:true});}
});

function fakeDebugger(events:string[]){
  const listeners=new Set<(source:chrome.debugger.Debuggee)=>void>(),frames=new Set<(source:chrome.debugger.Debuggee,method:string,params?:any)=>void>();
  return {permissions:{contains:async()=>true},debugger:{
    attach:async(target:chrome.debugger.Debuggee)=>{events.push('attach '+target.tabId);},
    sendCommand:async(target:chrome.debugger.Debuggee,method:string,params?:any)=>{events.push(`${target.tabId} ${method} ${params?.enabled}`);if(method==='Page.startScreencast')for(const listener of frames)listener(target,'Page.screencastFrame',{sessionId:0});},
    detach:async(target:chrome.debugger.Debuggee)=>{events.push('detach '+target.tabId);},
    onDetach:{addListener:(listener:(source:chrome.debugger.Debuggee)=>void)=>listeners.add(listener),removeListener:(listener:(source:chrome.debugger.Debuggee)=>void)=>listeners.delete(listener)},
    onEvent:{addListener:(listener:(source:chrome.debugger.Debuggee,method:string,params?:any)=>void)=>frames.add(listener),removeListener:(listener:(source:chrome.debugger.Debuggee,method:string,params?:any)=>void)=>frames.delete(listener)},
  },listeners,frames};
}

test('target CDP emulation begins before preparation, nested capture reuses it, and failure cleans up',async()=>{
  const original=globalThis.chrome,events:string[]=[],fake=fakeDebugger(events);
  Object.defineProperty(globalThis,'chrome',{value:fake,configurable:true});
  try{
    await assert.rejects(withTargetDebugger(12,async()=>{},async()=>{
      events.push('prepare');
      await withTargetDebugger(12,async()=>{},async target=>{assert.equal(target?.tabId,12);events.push('capture');});
      throw new PilotError('target_moved');
    }),/target_moved/);
    assert.deepEqual(events,['attach 12','12 Emulation.setFocusEmulationEnabled true','12 Page.enable undefined','12 Page.startScreencast undefined','12 Page.screencastFrameAck undefined','prepare','capture','12 Page.stopScreencast undefined','12 Emulation.setFocusEmulationEnabled false','detach 12']);
    assert.equal(fake.listeners.size,0);assert.equal(fake.frames.size,0);
  }finally{Object.defineProperty(globalThis,'chrome',{value:original,configurable:true});}
});

test('rendering stream is fixed to one pixel, ACKs only its own target, and never returns image bytes',async()=>{
  const original=globalThis.chrome,events:string[]=[],fake=fakeDebugger(events),commands:{method:string;params:any}[]=[];
  fake.debugger.sendCommand=async(target,method,params)=>{commands.push({method,params});if(method==='Page.startScreencast')for(const listener of fake.frames)listener(target,'Page.screencastFrame',{sessionId:0});};
  Object.defineProperty(globalThis,'chrome',{value:fake,configurable:true});
  try{
    const value=await withTargetDebugger(17,async()=>{},async()=>{
      for(const listener of fake.frames){
        listener({tabId:99},'Page.screencastFrame',{sessionId:1,data:'untrusted-pixels'});
        listener({tabId:17,sessionId:'other-session'} as any,'Page.screencastFrame',{sessionId:2,data:'untrusted-pixels'});
        listener({tabId:17},'Page.screencastFrame',{sessionId:3,data:'untrusted-pixels'});
      }
      return {completed:true};
    });
    assert.equal(value.completed,true);assert((value as any).backgroundTimings);assert(!JSON.stringify(commands).includes('untrusted-pixels'));
    assert.deepEqual(commands.find(command=>command.method==='Page.startScreencast')?.params,{format:'jpeg',quality:0,maxWidth:1,maxHeight:1,everyNthFrame:1});
    assert.deepEqual(commands.filter(command=>command.method==='Page.screencastFrameAck'),[{method:'Page.screencastFrameAck',params:{sessionId:0}},{method:'Page.screencastFrameAck',params:{sessionId:3}}]);
    commands.length=0;fake.debugger.sendCommand=async(_target,method)=>{if(method==='Page.startScreencast')throw new Error('Unsupported');};
    await assert.rejects(withTargetDebugger(17,async()=>{},async()=>assert.fail('Must not dispatch')),/background_rendering_unavailable/);
    assert.equal(fake.frames.size,0);
  }finally{Object.defineProperty(globalThis,'chrome',{value:original,configurable:true});}
});

test('unsupported background emulation fails before dispatch and detaches only its own debugger',async()=>{
  const original=globalThis.chrome,events:string[]=[],fake=fakeDebugger(events);
  fake.debugger.sendCommand=async()=>{throw new Error('Method not found');};
  Object.defineProperty(globalThis,'chrome',{value:fake,configurable:true});
  try{
    await assert.rejects(withTargetDebugger(13,async()=>{},async()=>assert.fail('Must not dispatch')),/background_emulation_unavailable/);
    assert.deepEqual(events,['attach 13','detach 13']);
    events.length=0;fake.debugger.attach=async()=>{throw new Error('Another debugger attached');};
    await assert.rejects(withTargetDebugger(14,async()=>{},async()=>assert.fail('Must not dispatch')),/background_debugger_unavailable/);
    assert.deepEqual(events,[],'Must not detach a competing debugger');
  }finally{Object.defineProperty(globalThis,'chrome',{value:original,configurable:true});}
});

test('CDP detachment and permission revocation reject nested input without reattaching',async()=>{
  const original=globalThis.chrome,events:string[]=[],fake=fakeDebugger(events);
  Object.defineProperty(globalThis,'chrome',{value:fake,configurable:true});
  try{
    await withTargetDebugger(15,async()=>{},async()=>{
      for(const listener of fake.listeners)listener({tabId:15});
      await assert.rejects(withTargetDebugger(15,async()=>{},async()=>assert.fail('Must not dispatch')),/background_interrupted/);
    });
    assert.equal(events.filter(event=>event.startsWith('attach')).length,1);assert(!events.includes('detach 15'));
    fake.permissions.contains=async()=>false;
    await assert.rejects(withTargetDebugger(16,async()=>{},async()=>assert.fail('Must not dispatch')),/native_input_permission_required/);
    assert.equal(await withTargetDebugger(16,async()=>{},async target=>target===undefined,false),true);
  }finally{Object.defineProperty(globalThis,'chrome',{value:original,configurable:true});}
});

test('cleanup failure preserves the sent result, warns, and quarantines the owned debugger',async()=>{
  const original=globalThis.chrome,events:string[]=[],fake=fakeDebugger(events);
  fake.debugger.detach=async()=>{throw new Error('Detach failed');};
  Object.defineProperty(globalThis,'chrome',{value:fake,configurable:true});
  try{
    const result=await withTargetDebugger(18,async()=>{},async()=>({dispatch:'sent'})) as any;
    assert.equal(result.dispatch,'sent');assert.equal(result.backgroundWarning.code,'background_cleanup_failed');
    await assert.rejects(withTargetDebugger(18,async()=>{},async()=>assert.fail('No new operation under failed cleanup')),/background_interrupted/);
    assert(events.includes('18 Page.stopScreencast undefined'));assert(events.includes('18 Emulation.setFocusEmulationEnabled false'));assert.equal(fake.frames.size,0);
    for(const listener of fake.listeners)listener({tabId:18});assert.equal(fake.listeners.size,0);
  }finally{Object.defineProperty(globalThis,'chrome',{value:original,configurable:true});}
});

test('discarded and frozen tabs fail before emulation or dispatch without activation',async()=>{
  const original=globalThis.chrome;
  try{for(const state of ['discarded','frozen']){
    Object.defineProperty(globalThis,'chrome',{configurable:true,value:{tabs:{get:async()=>({id:70,windowId:1,active:false,discarded:state==='discarded',frozen:state==='frozen'})},windows:{get:async()=>({focused:false,state:'minimized'})}}});
    await assert.rejects(withInteractiveTab(70,async()=>{},async()=>assert.fail('No action on an unavailable document')),error=>error instanceof PilotError&&error.code==='tab_'+state&&error.details?.dispatch==='not_sent'&&error.details?.tab?.windowState==='minimized');
  }}finally{Object.defineProperty(globalThis,'chrome',{configurable:true,value:original});}
});

test('a late debugger attach is quarantined and detached without executing the expired action',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const original=globalThis.chrome,events:string[]=[],fake=fakeDebugger(events);let finish!:()=>void;
  fake.debugger.attach=()=>new Promise<void>(resolve=>{finish=resolve;events.push('pending attach');});Object.defineProperty(globalThis,'chrome',{configurable:true,value:fake});
  try{
    const rejected=assert.rejects(withTargetDebugger(71,async()=>{},async()=>assert.fail('Expired action must never run')),/background_attach_timeout/);
    for(let i=0;i<20;i++)await Promise.resolve();t.mock.timers.tick(3001);await rejected;
    await assert.rejects(withTargetDebugger(71,async()=>{},async()=>assert.fail('Pending attach cannot be reused')),/background_interrupted/);
    finish();await new Promise<void>(resolve=>setImmediate(resolve));assert(events.includes('detach 71'));
    fake.debugger.attach=async()=>{};assert.equal(await withTargetDebugger(71,async()=>{},async()=>true),true);
  }finally{Object.defineProperty(globalThis,'chrome',{configurable:true,value:original});t.mock.timers.reset();}
});

test('a stream start without frame progress times out before dispatch and cleans up',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const original=globalThis.chrome,events:string[]=[],fake=fakeDebugger(events);
  fake.debugger.sendCommand=async()=>{};Object.defineProperty(globalThis,'chrome',{configurable:true,value:fake});
  try{
    const rejected=assert.rejects(withTargetDebugger(72,async()=>{},async()=>assert.fail('No renderer evidence')),/background_render_timeout/);
    for(let i=0;i<30;i++)await Promise.resolve();t.mock.timers.tick(1501);await rejected;assert(events.includes('detach 72'));assert.equal(fake.frames.size,0);
  }finally{Object.defineProperty(globalThis,'chrome',{configurable:true,value:original});t.mock.timers.reset();}
});

test('discard protection restores the previous policy and reports restore failure alongside a sent result',async()=>{
  const original=globalThis.chrome;
  try{for(const failRestore of [false,true]){
    let autoDiscardable=true;const updates:any[]=[];
    Object.defineProperty(globalThis,'chrome',{configurable:true,value:{permissions:{contains:async()=>false},windows:{get:async()=>({focused:false,state:'normal'})},tabs:{get:async()=>({id:73,windowId:1,active:false,discarded:false,autoDiscardable}),update:async(_id:number,input:any)=>{assert.deepEqual(Object.keys(input),['autoDiscardable']);updates.push(input.autoDiscardable);if(failRestore&&input.autoDiscardable)throw new Error('Restore failed');autoDiscardable=input.autoDiscardable;}}}});
    const result=await withInteractiveTab(73,async()=>{},async()=>{assert.equal(autoDiscardable,false);return {dispatch:'sent'};}) as any;
    assert.equal(result.dispatch,'sent');assert.deepEqual(updates,[false,true]);
    if(failRestore)assert.equal(result.backgroundWarning.code,'background_discard_restore_failed');else assert.equal(autoDiscardable,true);
  }}finally{Object.defineProperty(globalThis,'chrome',{configurable:true,value:original});}
});

test('a cached screencast frame cannot replace actual animation-frame progress',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const original=globalThis.chrome,events:string[]=[],fake=fakeDebugger(events);
  Object.assign(fake,{scripting:{executeScript:()=>new Promise(()=>{})}});
  Object.defineProperty(globalThis,'chrome',{configurable:true,value:fake});
  try{
    const rejected=assert.rejects(withTargetDebugger(74,async()=>{},async()=>assert.fail('A cached frame is insufficient')),/background_render_timeout/);
    for(let i=0;i<30;i++)await Promise.resolve();t.mock.timers.tick(1501);await rejected;
    assert(events.includes('74 Page.screencastFrameAck undefined'));assert(events.includes('detach 74'));assert.equal(fake.frames.size,0);
  }finally{Object.defineProperty(globalThis,'chrome',{configurable:true,value:original});t.mock.timers.reset();}
});

test('live DOM operations can proceed with explicit stalled-paint metadata; image capture still requires paint',async()=>{
  const original=globalThis.chrome,events:string[]=[],fake=fakeDebugger(events);
  Object.assign(fake,{scripting:{executeScript:async()=>[{result:{ready:false,visibility:'visible',hasFocus:true}}]}});
  Object.defineProperty(globalThis,'chrome',{configurable:true,value:fake});
  try{
    const result=await withTargetDebugger(75,async()=>{},async()=>{
      const native=await withTargetDebugger(75,async()=>{},async()=>({dispatch:'sent'}),true,false);assert.equal(native.dispatch,'sent');
      await assert.rejects(withTargetDebugger(75,async()=>{},async()=>assert.fail('Cannot capture stale pixels')),/background_render_timeout/);
      return native;
    },true,false) as any;
    assert.equal(result.backgroundReadiness.rendered,false);assert.equal(result.backgroundReadiness.geometry,'live_dom');assert.equal(events.filter(event=>event.startsWith('attach')).length,1);
  }finally{Object.defineProperty(globalThis,'chrome',{configurable:true,value:original});}
});
