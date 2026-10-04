import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeErrorCode } from '../src/extension/native-errors.js';

test('unknown native errors never expose local paths or sensitive details',()=>{
  assert.equal(nativeErrorCode('Unexpected failure at C:\\private\\account-token'), 'native_host_unavailable');
  assert.equal(nativeErrorCode(), 'native_host_unavailable');
});

test('panel receives Chrome disconnect cause and can reconnect without replaying actions',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const originalChrome=globalThis.chrome;
  let failure:string|undefined='Specified native messaging host not found.';
  let panelListener:any,stored:any;
  const sent:string[]=[];
  const ports:{disconnect:()=>void}[]=[];
  const runtime:any={id:'fixture-extension',getURL:(file:string)=>'chrome-extension://fixture-extension/'+file,
    onMessage:{addListener:(fn:any)=>{panelListener=fn;}}
  };
  runtime.connectNative=()=>{
    let onMessage:any,onDisconnect:any,disconnected=false;
    const port={
      onMessage:{addListener:(fn:any)=>{onMessage=fn;}},
      onDisconnect:{addListener:(fn:any)=>{onDisconnect=fn;}},
      disconnect:()=>{if(disconnected)return;disconnected=true;onDisconnect();},
      postMessage:(message:any)=>{
        sent.push(message.command);
        queueMicrotask(()=>{
          if(failure){runtime.lastError={message:failure};port.disconnect();delete runtime.lastError;}
          else onMessage({id:message.id,ok:true,data:{}});
        });
      }
    };
    ports.push(port);return port;
  };
  globalThis.chrome={runtime,storage:{local:{setAccessLevel:async()=>{},get:async()=>({profile:stored}),set:async(value:any)=>{stored=value.profile;}}},
    tabs:{onRemoved:{addListener:()=>{}},onUpdated:{addListener:()=>{}},onCreated:{addListener:()=>{}}},
    webNavigation:{onBeforeNavigate:{addListener:()=>{}}},
    sidePanel:{setPanelBehavior:async()=>{}}
  } as any;
  const rpc=()=>new Promise<any>(resolve=>panelListener({command:'sessions.list'},{id:runtime.id,url:runtime.getURL('panel.html')},resolve));
  try {
    await import('../src/extension/background.js');
    await new Promise<void>(resolve=>setImmediate(resolve));
    for(const [message,code] of [
      ['Specified native messaging host not found.','native_host_not_registered'],
      ['Access to the specified native messaging host is forbidden.','native_host_forbidden'],
      ['Failed to start native messaging host.','native_host_start_failed'],
      ['Native host has exited.','native_host_exited'],
      ['Error when communicating with the native messaging host.','native_host_protocol_error']
    ]){
      failure=message;assert.deepEqual(await rpc(),{ok:false,code});
    }
    failure=undefined;
    const result=await rpc();assert.equal(result.ok,true);
    assert.equal(result.data.length,1);assert.equal(result.data[0].id,'panel');
    assert(sent.every(command=>['hello','profile.detect'].includes(command)),'reconnect must not replay browser or vault commands');
    assert.equal(stored.mcpEnabled,true);assert.equal(stored.mode,'safe');assert.equal(stored.vaultEnabled,false);
  } finally {
    for(const port of ports)port.disconnect();
    globalThis.chrome=originalChrome;t.mock.timers.reset();
  }
});
