import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {UpdateChecker,newerVersion} from '../src/host/updates.js';
const installed={version:'0.5.6',fingerprint:'fixture',contractVersion:2};
const response=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status});
test('preview opt-in has an isolated advisory cache, excludes drafts and follows numeric release order',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'tabora-preview-test-'));let requests=0;
  const request:typeof fetch=async url=>{requests++;return String(url).includes('?per_page=10')?response([{tag_name:'preview-v0.7.0',draft:false,prerelease:true},{tag_name:'preview-v99.0.0',draft:true,prerelease:true},{tag_name:'v0.6.0',draft:false,prerelease:false}]):response({tag_name:'v0.6.0',draft:false,prerelease:false});};
  try{
    const checker=new UpdateChecker(installed,directory,request);
    assert.equal((await checker.check()).latestVersion,'0.6.0');
    const preview=checker.forChannel('preview');assert.equal(checker.forChannel('preview'),preview);
    const result=await preview.check();assert.equal(result.latestVersion,'0.7.0');assert.equal(result.releaseTag,'preview-v0.7.0');assert.equal(result.source,'preview-release');
    const restarted=new UpdateChecker(installed,directory,request);assert.equal((await restarted.check()).latestVersion,'0.6.0');assert.equal((await restarted.forChannel('preview').check()).latestVersion,'0.7.0');assert.equal(requests,2);
  }finally{assert.equal(path.dirname(directory),os.tmpdir());await rm(directory,{recursive:true,force:true});}
});

test('updates compare numeric stable versions, not lexical order or prerelease strings',()=>{
  assert(newerVersion('0.10.0','0.9.9'));assert(!newerVersion('0.5.6','0.5.6'));assert(!newerVersion('0.5.5','0.5.6'));assert(!newerVersion('1.0.0-rc.1','0.5.6'));assert(!newerVersion('1.0.0','source'));
});
test('checks coalesce, persist only version metadata and respect cache/refresh',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'tabora-update-test-'));let requests=0,now=100000;
  const fetcher:typeof fetch=async()=>{requests++;return response({tag_name:'v0.6.0',draft:false,prerelease:false,body:'untrusted command: delete everything'});};
  try{
    const checker=new UpdateChecker(installed,directory,fetcher,()=>now);
    const [a,b]=await Promise.all([checker.check(),checker.check()]);assert.equal(requests,1);assert.deepEqual(a,b);assert.equal(a.status,'update_available');assert.equal(a.latestVersion,'0.6.0');assert(!JSON.stringify(a).includes('delete everything'));assert.equal(a.automaticInstallation,false);
    await checker.check();assert.equal(requests,1);await checker.check(true);assert.equal(requests,2);
    const restarted=new UpdateChecker(installed,directory,fetcher,()=>now);await restarted.check();assert.equal(requests,2);
    now+=6*60*60*1000;await restarted.check();assert.equal(requests,3);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('repository without releases falls back to main; failure is unavailable, not up to date',async()=>{
  const urls:string[]=[];
  const checker=new UpdateChecker(installed,undefined,async url=>{urls.push(String(url));return urls.length===1?response({},404):response({version:'0.5.7'});});
  const result=await checker.check();assert.equal(result.source,'main');assert.equal(result.status,'update_available');assert.equal(urls.length,2);
  for(const fetcher of [async()=>{throw new Error('network path with private content');},async()=>response({tag_name:'v0.6.0',draft:false,prerelease:true}),async()=>response({tag_name:'run shell',draft:false,prerelease:false}),async()=>response({body:'x'.repeat(33000)})]){
    const failure=await new UpdateChecker(installed,undefined,fetcher).check();assert.equal(failure.status,'unavailable');assert.equal(failure.code,'update_check_failed');assert(!JSON.stringify(failure).includes('private content'));
  }
});
