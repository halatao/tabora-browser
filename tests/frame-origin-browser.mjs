import './require-source-host.mjs';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,rm,cp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

await mkdir('.test-state',{recursive:true});
const directory=await mkdtemp(path.resolve('.test-state/frame-origin-'));
const extension=path.join(directory,'extension');await cp('dist/extension',extension,{recursive:true});
await build({stdin:{contents:"import {createCapabilitySession} from './src/extension/v2-session.ts'; globalThis.makeSession=createCapabilitySession;",resolveDir:process.cwd()},bundle:true,format:'esm',platform:'browser',outfile:path.join(extension,'frame-test.js')});
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));manifest.background.service_worker='frame-test.js';await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
const server=createServer((request,response)=>{response.setHeader('Content-Type','text/html');response.end(request.url==='/child'?(request.headers.host.startsWith('localhost')?'<iframe srcdoc="<p>Foreign inherited text</p>"></iframe>':'<p>Sandbox HTTP text</p>'):'<!doctype html><body><iframe srcdoc="<body role=application contenteditable=false aria-disabled=true><p>Inherited text</p></body>"></iframe><iframe sandbox="allow-scripts" srcdoc="<p>Opaque text</p>"></iframe><iframe></iframe><iframe src="http://localhost:'+server.address().port+'/child"></iframe><iframe sandbox="allow-scripts" src="/child"></iframe>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let context;
try{
  context=await chromium.launchPersistentContext(directory,{channel:'chromium',headless:true,args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  const page=await context.newPage();await page.goto('http://127.0.0.1:'+server.address().port+'/');
  const result=await worker.evaluate(async()=>{
    const tab=(await chrome.tabs.query({})).find(tab=>tab.url?.startsWith('http://127.0.0.1:'));
    const root=(await chrome.webNavigation.getAllFrames({tabId:tab.id})).find(f=>f.frameId===0);
    const origin=new URL(tab.url).origin,binding={tabId:tab.id,documentId:root.documentId,origin};
    const session=globalThis.makeSession('frame-test',()=>binding,()=>({mode:'safe',vaultEnabled:false}),async()=>{},()=>0,()=>[],async()=>binding,()=>false);
    const frames=await session.command('frames',{}),observations=[];
    for(const frame of frames.frames??frames){
      try{const state=await session.command('state',{frameId:frame.frameId,cursor:0,limit:100});const reads=[];if(frame.url==='about:srcdoc')for(const target of state.snapshot.targets)reads.push(await session.command('read',{frameId:frame.frameId,targetId:target.id,format:'text',offset:0,limit:16000}));observations.push({frameId:frame.frameId,state,reads});}
      catch(error){observations.push({frameId:frame.frameId,error:error.code??error.message});}
    }
    const after=await session.command('frames',{});return {frames:frames.frames??frames,after:after.frames,observations,origin};
  });
  assert.equal(result.frames.length,7);
  for(const frame of result.frames){
    assert.equal(typeof frame.url,'string');
    const observation=result.observations.find(o=>o.frameId===frame.frameId);
    if(frame.origin==='null'){
      assert.equal(frame.allowed,false);assert.equal(frame.reason,'frame_opaque_origin');assert.equal(observation.error,'frame_not_permitted');
    }else if(frame.origin?.includes('localhost')){
      assert.equal(frame.allowed,false);assert.equal(frame.reason,'frame_origin_not_granted');assert.equal(observation.error,'frame_not_permitted');
    }else{
      assert.equal(frame.allowed,true,JSON.stringify(frame));assert.equal(result.after.find(f=>f.frameId===frame.frameId).readerInjected,true);assert.equal(frame.origin,result.origin);assert.equal(observation.state.snapshot.origin,result.origin);
      if(frame.url==='about:srcdoc')assert(observation.reads.some(read=>JSON.stringify(read).includes('Inherited text')),JSON.stringify(observation));
    }
  }
  console.log('PASS: inherited blank/srcdoc read; opaque srcdoc/HTTP and foreign frames blocked with origin diagnostics');
}finally{await context?.close();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
