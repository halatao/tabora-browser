import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

// Native framing and real DPAPI only, in a disposable state directory. No registration or browser profile.
const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'vault-session-native-'));
const extensionId=(await readFile('extension-id.txt','utf8')).trim(),clients=new Set(),profileId=randomUUID();
const brokerPath=path.resolve('dist/host/broker.js').replaceAll("'","''");
const frame=value=>{const body=Buffer.from(JSON.stringify(value)),prefix=Buffer.alloc(4);prefix.writeUInt32LE(body.length);return Buffer.concat([prefix,body]);};
async function client(id=profileId,vaultEnabled=true){
  const child=spawn(process.execPath,['dist/host/main.js',`chrome-extension://${extensionId}/`],{windowsHide:true,env:{...process.env,TABORA_STATE_DIR:directory},stdio:['pipe','pipe','pipe']});clients.add(child);
  const pending=new Map();let buffered=Buffer.alloc(0);child.stderr.resume();
  child.stdout.on('data',part=>{buffered=Buffer.concat([buffered,part]);while(buffered.length>=4){const length=buffered.readUInt32LE(0);if(buffered.length<length+4)break;const message=JSON.parse(buffered.subarray(4,length+4));buffered=buffered.subarray(length+4);if(message.event==='browser-command'){assert.equal(message.command,'configuration.changed');child.stdin.write(frame({event:'browser-result',id:message.id,ok:true,data:{invalidated:true}}));continue;}const waiter=pending.get(message.id);if(waiter){pending.delete(message.id);clearTimeout(waiter.timer);waiter.resolve(message);}}});
  child.on('exit',()=>{for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(Error('native_process_exited'));}pending.clear();});
  async function call(command,payload){const requestId=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('native_timeout_'+command)),20000);pending.set(requestId,{resolve,reject,timer});child.stdin.write(frame({id:requestId,version:1,command,payload}));});}
  const hello=await call('hello',{id,name:'Synthetic session policy',mcpEnabled:true,vaultEnabled,mode:'takeover'});assert(hello.ok,JSON.stringify(hello));
  return {child,call,async close(){if(child.exitCode!==null){clients.delete(child);return;}const exited=new Promise(resolve=>child.once('exit',resolve));child.stdin.end();const timer=setTimeout(()=>child.kill(),10000);await exited;clearTimeout(timer);clients.delete(child);}};
}
async function brokerPid(parentPid){
  const script=`$owned = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.ParentProcessId -eq ${parentPid} -and $_.CommandLine -like '*${brokerPath}*' }); if ($owned.Count -ne 1) { throw 'Ambiguous test broker' }; [Console]::Out.Write($owned[0].ProcessId)`;
  return Number(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,encoding:'utf8',timeout:10000}));
}
async function waitExit(pid){
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')return;throw error;}await new Promise(resolve=>setTimeout(resolve,100));}
  throw Error('Test broker did not exit while idle');
}
const watchdog=setTimeout(()=>{console.error('Vault session native test timed out');process.exit(1);},120000);
try{
  let c=await client();let pid=await brokerPid(c.child.pid);
  assert.equal((await c.call('status')).data.locked,true);
  assert((await c.call('vault.unlock')).ok);assert.equal((await c.call('status')).data.vaultUnlockLifetime,'windows_session');
  const secret='SYNTHETIC-SESSION-ONLY';assert((await c.call('vault.put',{kind:'website',label:'Synthetic only',origin:'https://fixture.test',username:'fixture',secret,scope:{type:'profile',profileId}})).ok);
  await c.close();await waitExit(pid);
  c=await client();pid=await brokerPid(c.child.pid);assert.equal((await c.call('status')).data.locked,false,'Explicit unlock must survive a full broker restart in the same Windows session');
  const entries=await c.call('vault.list');assert(entries.ok);assert.equal(entries.data.length,1);assert(!JSON.stringify(entries).includes(secret));
  const other=await client(randomUUID());assert.equal((await other.call('status')).data.locked,true);await other.close();
  assert((await c.call('vault.lock')).ok);await c.close();await waitExit(pid);
  c=await client();pid=await brokerPid(c.child.pid);assert.equal((await c.call('status')).data.locked,true,'Manual lock must survive restart');
  assert((await c.call('vault.unlock')).ok);await c.close();await waitExit(pid);
  c=await client(profileId,false);pid=await brokerPid(c.child.pid);assert.equal((await c.call('status')).data.locked,true);await c.close();await waitExit(pid);
  c=await client();pid=await brokerPid(c.child.pid);assert.equal((await c.call('status')).data.locked,true,'Disabled vault must not recover old consent when re-enabled');
  await c.close();await waitExit(pid);
  console.log('PASS: real Windows session/DPAPI consent survives broker restart; manual lock, disabled vault and profile isolation remain enforced. Idle brokers exit normally.');
}finally{
  clearTimeout(watchdog);for(const child of clients){child.stdin.end();if(child.exitCode===null)child.kill();}
  assert.equal(path.dirname(directory),base);await rm(directory,{recursive:true,force:true,maxRetries:3});
}
