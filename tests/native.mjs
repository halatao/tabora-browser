import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const dir=await mkdtemp(path.join(base,'native-'));
const id=(await readFile('extension-id.txt','utf8')).trim();
const child=spawn(process.execPath,['dist/host/main.js',`chrome-extension://${id}/`],{env:{...process.env,TABORA_STATE_DIR:dir,TABORA_BROWSER_NAME:'Synthetic managed profile'},stdio:['pipe','pipe','pipe'],windowsHide:true});
const pending=new Map();let buffer=Buffer.alloc(0),stderr='';child.stderr.on('data',d=>stderr+=d.toString());
function frame(message){const body=Buffer.from(JSON.stringify(message)),prefix=Buffer.alloc(4);prefix.writeUInt32LE(body.length);return Buffer.concat([prefix,body]);}
child.stdout.on('data',data=>{buffer=Buffer.concat([buffer,data]);while(buffer.length>=4){const size=buffer.readUInt32LE(0);if(buffer.length<size+4)return;const msg=JSON.parse(buffer.subarray(4,size+4));buffer=buffer.subarray(size+4);if(msg.event==='browser-command'){assert.equal(msg.command,'configuration.changed');child.stdin.write(frame({event:'browser-result',id:msg.id,ok:true,data:{invalidated:true}}));continue;}const waiter=pending.get(msg.id);if(waiter){pending.delete(msg.id);clearTimeout(waiter.timer);waiter.resolve(msg);}}});
function call(command,payload){return new Promise((resolve,reject)=>{const id=randomUUID(),body=Buffer.from(JSON.stringify({id,version:1,command,payload})),prefix=Buffer.alloc(4);prefix.writeUInt32LE(body.length);const timer=setTimeout(()=>reject(new Error('Native timeout: '+command)),15000);pending.set(id,{resolve,timer});child.stdin.write(Buffer.concat([prefix,body]));});}
try {
  assert.equal((await call('hello',{id:randomUUID(),name:'Native test',mcpEnabled:false})).ok,true);
  assert((await call('status')).data.locked);
  const detected=await call('profile.detect',{browser:'chrome'});assert.equal(detected.ok,true);assert.equal(detected.data.automatic.name,'Synthetic managed profile');
  assert.equal((await call('vault.unlock')).ok,true);
  const saved=await call('vault.put',{kind:'website',label:'Synthetic test',origin:'https://fixture.test',username:'tester',secret:'FAKE-native-test-password'});
  assert(saved.ok);assert(!JSON.stringify(saved).includes('FAKE-native-test-password'));
  const binding={tabId:1,documentId:'test-document',origin:'https://fixture.test'};await call('bind',binding);
  assert.equal((await call('credential.use',{id:saved.data.entries[0].id,binding:{...binding,origin:'https://evil.test'}})).ok,false);
  const credential=await call('credential.use',{id:saved.data.entries[0].id,binding});assert.equal(credential.data.password,'FAKE-native-test-password');
  const disk=await readFile(path.join(dir,'vault.json'),'utf8');assert(!disk.includes('FAKE-native-test-password'));assert(!disk.includes('tester'));
  await call('vault.lock');assert.equal((await call('credential.use',{id:saved.data.entries[0].id,binding})).code,'vault_locked');
  await call('vault.unlock');assert.equal((await call('vault.list')).data.length,1);
  const result=await call('decide',{provider:'openai-decisions',request:{requestId:'test',stateVersion:'doc1',question:'Select',context:{},choices:[{id:'a',description:'A'},{id:'ask_user',description:'Ask'}]}});
  assert.equal(result.data.code,'decisions_preview_unavailable');
  assert(!stderr.includes('FAKE-native-test-password'));
  console.log('PASS: Native framing, real Windows DPAPI persistence, metadata redaction, origin binding, lock and unavailable Decisions.');
}finally{
  child.stdin.end();await new Promise(resolve=>child.once('exit',resolve));
  assert.equal(path.dirname(dir),base);await rm(dir,{recursive:true,force:true});
}
