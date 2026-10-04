import test from 'node:test';import assert from 'node:assert/strict';import {exportData} from '../src/host/export-policy.js';import {InteractiveQueue} from '../src/host/interactive-queue.js';
test('export strips auth URL data and redacts known vault values without changing business query',()=>{
  const result=exportData({text:'See https://user:pw@test.local/path?access_token=private&category=abc',value:'vault-canary'},value=>JSON.parse(JSON.stringify(value).split('vault-canary').join('[REDACTED]')));
  assert(!JSON.stringify(result).includes('private'));assert(!JSON.stringify(result).includes('user:pw'));assert(result.text.includes('category=abc'));assert.equal(result.value,'[REDACTED]');
});
test('desktop execution serializes across profiles and releases after failure',async()=>{
  const queue=new InteractiveQueue(),order:string[]=[];let release!:()=>void;
  const first=queue.run(async()=>{order.push('A');await new Promise<void>(resolve=>{release=resolve;});throw Error('test');});
  const second=queue.run(async()=>{order.push('B');});await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(order,['A']);release();await assert.rejects(first);await second;assert.deepEqual(order,['A','B']);
});
test('short secrets are redacted from content without corrupting locally generated protocol references',()=>{
  const id='aabc1111-2222-4333-8444-555555555555',result=exportData({id,targetId:'r10',stateVersion:id+':'+id,sha256:'a'.repeat(64),text:'a private value',recordKey:'a-record'},value=>typeof value==='string'?value.replaceAll('a','[REDACTED]'):value);
  assert.equal(result.id,id);assert.equal(result.stateVersion,id+':'+id);assert.equal(result.sha256,'a'.repeat(64));assert(!result.text.includes('a'));assert(result.recordKey.includes('[REDACTED]'));
});

test('export preserves exact origin and nonsensitive navigation serialization',()=>{
  const origin='https://127.0.0.1:44321',url=origin+'/task?orderNumber=000123&category=a%20b';
  assert.deepEqual(exportData({origin,allowedOrigins:[origin],url}),{origin,allowedOrigins:[origin],url});
  assert(!JSON.stringify(exportData({url:url+'&access_token=private'})).includes('private'));
});
