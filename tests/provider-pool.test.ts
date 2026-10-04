import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {DecisionPool} from '../src/host/providers.js';
import {type ProviderConfig,type DecisionRequest} from '../src/shared.js';
const config:ProviderConfig={provider:'codex-sdk',model:'fixture',connection:'sdk',timeoutMs:5000};
const request:DecisionRequest={requestId:'test',stateVersion:'document',question:'Choose',context:{},choices:[{id:'a',description:'A'},{id:'b',description:'B'}]};
test('pool reuses a runtime within scope, isolates profiles, replaces config and cleans directories',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'tabora-pool-')),pool=new DecisionPool(dir,{workerPath:path.resolve('tests/fixtures/provider-worker.mjs')});
  try{
    const first=await pool.decide('profileA:session:codex',config,request,'',AbortSignal.timeout(5000));
    const warm=await pool.decide('profileA:session:codex',config,{...request,choices:[...request.choices].reverse()},'',AbortSignal.timeout(5000));
    assert.equal(first.status,'selected');assert.equal(warm.choiceId,'b');assert.equal(first.diagnostics?.processId,warm.diagnostics?.processId);
    assert.equal(first.runtime?.coldStart,true);assert.equal(warm.runtime?.coldStart,false);
    assert(first.runtime!.dispatchMs>0);assert(first.latencyMs>=first.runtime!.dispatchMs);assert.equal(warm.runtime?.cleanupMs,0);
    const other=await pool.decide('profileB:session:codex',config,request,'',AbortSignal.timeout(5000));assert.notEqual(first.diagnostics?.processId,other.diagnostics?.processId);
    const changed=await pool.decide('profileA:session:codex',{...config,model:'other'},request,'',AbortSignal.timeout(5000));assert.notEqual(first.diagnostics?.processId,changed.diagnostics?.processId);
    await pool.close();assert.deepEqual(await readdir(path.join(dir,'runs')),[]);
  }finally{await pool.close();assert.equal(path.dirname(dir),os.tmpdir());await rm(dir,{recursive:true,force:true,maxRetries:3});}
});
test('pool rejects overlap and cancels a hanging process without accepting a stale response',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'tabora-pool-')),pool=new DecisionPool(dir,{workerPath:path.resolve('tests/fixtures/provider-worker.mjs')});
  try{
    const abort=new AbortController(),pending=pool.decide('p:s:c',config,{...request,question:'Hang'},'',abort.signal);
    assert.equal((await pool.decide('p:s:c',config,request,'',AbortSignal.timeout(5000))).code,'session_busy');
    setTimeout(()=>abort.abort(),100);assert.equal((await pending).code,'cancelled');
    const next=await pool.decide('p:s:c',config,request,'',AbortSignal.timeout(5000));assert.equal(next.status,'selected');
  }finally{await pool.close();assert.equal(path.dirname(dir),os.tmpdir());await rm(dir,{recursive:true,force:true,maxRetries:3});}
});
test('close waits for a runtime already invalidated by disconnection',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'tabora-pool-')),pool=new DecisionPool(dir,{workerPath:path.resolve('tests/fixtures/provider-worker.mjs')});
  try{await pool.decide('p:s:c',config,request,'',AbortSignal.timeout(5000));pool.invalidate('p:');await pool.close();assert.deepEqual(await readdir(path.join(dir,'runs')),[]);}
  finally{await pool.close();assert.equal(path.dirname(dir),os.tmpdir());await rm(dir,{recursive:true,force:true,maxRetries:3});}
});
