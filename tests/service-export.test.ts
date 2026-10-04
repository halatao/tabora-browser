import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Vault} from '../src/host/vault.js';
import {HostService} from '../src/host/service.js';

test('real host decision boundary redacts synthetic vault credentials before the controlled provider sink',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'tabora-export-'));
  // An in-memory OS protector is confined to this synthetic test process.
  let protectedKey:Buffer|undefined;
  const vault=new Vault(path.join(directory,'vault.json'),{protect:async key=>{protectedKey=Buffer.from(key);return Buffer.from('test-key-handle');},unprotect:async()=>Buffer.from(protectedKey!)});
  const service=new HostService(vault,directory),canary='SYNTHETIC-CREDENTIAL-'+crypto.randomUUID();
  const captures:any[]=[];
  // Observe the actual HostService -> DecisionPool boundary without paid calls.
  (service as any).pool={invalidate(){},async close(){},async decide(scope:string,config:any,request:any,key:string){captures.push({scope,config,request,key});return {status:'selected',choiceId:'continue',model:config.model,provider:config.provider};}};
  try{
    await service.handle('profile','session','configure',{provider:'codex-sdk',model:'controlled-model',connection:'sdk',timeoutMs:5000});
    await service.handle('profile','session','vault.unlock',{});
    await service.handle('profile','session','vault.put',{kind:'website',label:'Synthetic',origin:'https://example.test',username:'synthetic-user',secret:canary});
    const request={requestId:'sink-test',stateVersion:'document',question:'Continue '+canary,context:{page:'https://example.test/task?orderNumber=000123&access_token='+canary,password:canary},choices:[{id:'continue',description:'Continue '+canary},{id:'handoff',description:'Stop'}]};
    const result=await service.handle('profile','session','decide',{provider:'codex-sdk',request});
    assert.equal(result.status,'selected');assert.equal(captures.length,1);
    assert.equal(captures[0].config.provider,'codex-sdk');assert.equal(captures[0].config.model,'controlled-model');
    const exported=JSON.stringify(captures);assert(!exported.includes(canary));assert(exported.includes('orderNumber=000123'));assert(exported.includes('[REDACTED]'));
    assert(!JSON.stringify(result).includes(canary));assert(!(await readFile(path.join(directory,'vault.json'),'utf8')).includes(canary));
  }finally{await service.close();protectedKey?.fill(0);assert.equal(path.dirname(directory),os.tmpdir());await rm(directory,{recursive:true,force:true});}
});
