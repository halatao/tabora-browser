import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {chromium} from 'playwright';

const bundle=await build({entryPoints:['src/extension/sensor.ts'],bundle:true,write:false,format:'iife',platform:'browser'});
const server=createServer((request,response)=>response.end('<!doctype html><body>'+Array.from({length:140},(_,i)=>`<a href="#">Background ${i}</a>`).join('')+'<div onclick="this.dataset.clicked=1" style="position:fixed;top:100px;left:100px;width:100px;height:40px">WEEKLY</div><div style="height:3000px"></div><div id="overlay" class="consent-overlay" style="position:fixed;inset:0;z-index:10"><div role="dialog" aria-label="Privacy choice"><button aria-label="Close" onclick="document.querySelector(\'#overlay\').remove()">Close</button></div></div>'));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  const origin=new URL(page.url()).origin;
  const call=input=>page.evaluate(input=>globalThis.__taboraOperation(input),{...input,origin,sessionId:'overlay-scroll'});
  let observation=await call({op:'observe',cursor:0,limit:10});
  assert(observation.snapshot.targets.some(t=>t.name==='Close'),'Late DOM dialog control is prioritized on the first page');
  const body=observation.snapshot.targets.find(t=>t.name==='Page body');assert(body.scrollable);assert(body.scroll.maxY>0);
  const scroll=await call({op:'action',snapshotId:observation.snapshot.snapshotId,action:{type:'scroll',targetId:body.id,x:0,y:900}});
  assert(scroll.progress);assert(scroll.scroll.y>0);assert.equal(await page.evaluate(()=>document.scrollingElement.scrollTop),scroll.scroll.y);
  observation=await call({op:'observe',cursor:0,limit:100});let weekly;
  while(!weekly){weekly=observation.snapshot.targets.find(t=>t.name==='WEEKLY');if(weekly)break;assert.notEqual(observation.snapshot.coverage.nextCursor,null);observation=await call({op:'observe',cursor:observation.snapshot.coverage.nextCursor,limit:100});}
  for(const op of ['action','native_prepare']){
    const blocked=await call({op,snapshotId:observation.snapshot.snapshotId,action:{type:'click',targetId:weekly.id,backend:op==='action'?'dom':'native'}});
    assert.equal(blocked.code,'target_obscured');assert.equal(blocked.details.targetId,weekly.id);assert(blocked.details.blockers.some(b=>b.id==='overlay'&&b.className==='consent-overlay'));
    observation=await call({op:'observe',cursor:0,limit:100});while(!observation.snapshot.targets.some(t=>t.id===weekly.id))observation=await call({op:'observe',cursor:observation.snapshot.coverage.nextCursor,limit:100});
  }
  await page.getByRole('button',{name:'Close',exact:true}).click();
  observation=await call({op:'observe',cursor:0,limit:100});while(!observation.snapshot.targets.some(t=>t.id===weekly.id))observation=await call({op:'observe',cursor:observation.snapshot.coverage.nextCursor,limit:100});weekly=observation.snapshot.targets.find(t=>t.name==='WEEKLY');assert(weekly);
  const clicked=await call({op:'action',snapshotId:observation.snapshot.snapshotId,action:{type:'click',targetId:weekly.id,backend:'dom'}});assert.equal(clicked.dispatch,'sent');
  assert.equal(await page.getByText('WEEKLY',{exact:true}).getAttribute('data-clicked'),'1');
  await page.setContent('<!doctype html><body style="margin:0"><div style="height:680px"></div><button onclick="this.dataset.clicked=1">Week picker</button><div style="height:2000px"></div><div id="fixed-footer" style="position:fixed;bottom:0;height:180px;width:100%;background:white;z-index:10">Sticky footer</div>');
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  observation=await call({op:'observe',cursor:0,limit:100});const picker=observation.snapshot.targets.find(t=>t.name==='Week picker');assert(picker);
  const recovered=await call({op:'action',snapshotId:observation.snapshot.snapshotId,action:{type:'click',targetId:picker.id,backend:'dom'}});
  assert.equal(recovered.dispatch,'sent');assert.equal(await page.getByRole('button',{name:'Week picker'}).getAttribute('data-clicked'),'1');
  assert(await page.evaluate(()=>document.scrollingElement.scrollTop)>0,'Fixed footer is resolved by real scroll, not bypassed');
  for(const op of ['action','native_prepare'])for(const delay of [100,700,1800]){
    await page.setContent('<body><button onclick="globalThis.writes=(globalThis.writes??0)+1">Save</button><div id="transient" style="position:fixed;inset:0;z-index:10;background:white">Loading</div>');
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    const state=await call({op:'observe',cursor:0,limit:100}),save=state.snapshot.targets.find(target=>target.name==='Save');
    await page.evaluate(delay=>{globalThis.writes=0;setTimeout(()=>document.querySelector('#transient').remove(),delay);},delay);
    const started=performance.now(),result=await call({op,snapshotId:state.snapshot.snapshotId,action:{type:'click',targetId:save.id,backend:op==='action'?'dom':'native'}});
    assert.equal(result.ok,true,JSON.stringify(result));assert(performance.now()-started>=delay-80);assert.equal(await page.evaluate(()=>globalThis.writes),op==='action'?1:0);
  }
  for(const mutation of ['cancel','recycle','offscreen']){
    await page.setContent('<body><button onclick="globalThis.writes++">Save</button><div id="transient" style="position:fixed;inset:0;z-index:10;background:white">Loading</div>');
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    const state=await call({op:'observe',cursor:0,limit:100}),save=state.snapshot.targets.find(target=>target.name==='Save');await page.evaluate(()=>{globalThis.writes=0;});
    if(mutation==='offscreen')await page.evaluate(()=>{document.querySelector('button').style.cssText='position:fixed;left:-500px';document.querySelector('#transient').remove();});
    const action=call({op:'action',snapshotId:state.snapshot.snapshotId,action:{type:'click',targetId:save.id,backend:'dom'}});
    if(mutation!=='offscreen'){
      await new Promise(resolve=>setTimeout(resolve,100));
      if(mutation==='cancel')await call({op:'cancel'});
      else await page.evaluate(()=>{document.querySelector('button').textContent='Different record';document.querySelector('#transient').remove();});
    }
    const result=await action;assert.equal(result.ok,false);assert.equal(await page.evaluate(()=>globalThis.writes),0);
    if(mutation==='offscreen'){assert.equal(result.details.cause,'outside_viewport');assert.deepEqual(result.details.blockers,[]);}
    else assert.equal(result.code,'stale_reference');
  }
  console.log('PASS: dialog priority, root scroll, DOM/native occlusion identity and recovery without bypass');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
