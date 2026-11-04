// Real sensor/DOM regression without an installed extension or a live account.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {chromium} from 'playwright';

const bundle=await build({entryPoints:['src/extension/sensor.ts'],bundle:true,write:false,format:'iife',platform:'browser'});
const server=createServer((request,response)=>response.end('<!doctype html><body><div role="img" aria-label="Photo" style="position:fixed;left:20px;top:80px;width:200px;height:160px;background:green"></div><input style="position:absolute;left:800px;top:600px"><div id="extra" style="position:absolute;left:900px;top:600px;width:30px;height:30px"></div><div style="height:2000px"></div>'));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1200,height:900}});
  await page.goto(origin);
  await page.evaluate(()=>{
    const original=globalThis.setTimeout;
    globalThis.setTimeout=(callback,ms,...args)=>{if(ms===5000){globalThis.expireCapture=callback;return -1;}return original(callback,ms,...args);};
  });
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  const call=input=>page.evaluate(input=>globalThis.__taboraOperation(input),{...input,origin,sessionId:'capture-regression'});
  const prepare=async(extra=false)=>{
    await call({op:'capture_clear'});
    const observation=await call({op:'observe',cursor:0,limit:100});assert(observation.ok);
    const photo=observation.snapshot.targets.find(target=>target.name==='Photo');
    const redactTargets=extra?[observation.snapshot.targets.find(target=>target.name==='Extra').id]:[];
    const result=await call({op:'capture_mask',snapshotId:observation.snapshot.snapshotId,targetId:photo.id,redactTargets});
    assert(result.ok,JSON.stringify(result));return result;
  };
  const valid=async()=>assert.equal((await call({op:'capture_validate'})).ok,true);
  const rejected=async()=>assert.equal((await call({op:'capture_validate'})).code,'capture_redaction_changed');
  await prepare();await valid();
  await page.evaluate(()=>document.querySelector('input').style.left='801px');await valid();
  await page.evaluate(()=>document.querySelector('input').style.cssText='position:fixed;left:50px;top:100px;width:50px;height:20px');await rejected();
  const masked=await prepare();assert.equal(masked.pixelRedaction.masks.length,1);await valid();
  await page.evaluate(()=>document.querySelector('input').style.left='51px');await rejected();
  await prepare();
  await page.evaluate(()=>{const frame=document.createElement('iframe');frame.style.cssText='position:fixed;left:180px;top:100px;width:80px;height:40px';document.body.append(frame);});await rejected();
  await page.evaluate(()=>{document.querySelector('iframe').remove();document.querySelector('input').style.cssText='position:absolute;left:800px;top:600px';const extra=document.querySelector('#extra');extra.setAttribute('role','img');extra.setAttribute('aria-label','Extra');});
  await prepare(true);
  await page.evaluate(()=>document.querySelector('#extra').style.cssText='position:fixed;left:60px;top:110px;width:30px;height:30px');await rejected();
  await prepare();
  await page.evaluate(()=>document.querySelector('[aria-label="Photo"]').style.left='21px');await rejected();
  await prepare();await page.evaluate(()=>window.scrollTo(0,20));await rejected();
  await prepare();await page.setViewportSize({width:1190,height:900});await rejected();
  await prepare();await page.evaluate(()=>globalThis.expireCapture());await rejected();
  await call({op:'capture_clear'});
  await page.evaluate(()=>{const filler=document.createElement('div');filler.hidden=true;filler.innerHTML='<span></span>'.repeat(6000);document.body.append(filler);const late=document.createElement('input');late.id='late-private';late.value='must not leak';late.style.cssText='position:fixed;left:50px;top:100px;width:50px;height:20px';document.body.append(late);});
  const large=await prepare();assert(large.pixelRedaction.masks.length>0);await valid();
  await page.evaluate(()=>{document.querySelector('#late-private').style.left='52px';});await rejected();
  await page.evaluate(()=>{const filler=document.createElement('div');filler.hidden=true;filler.innerHTML='<span></span>'.repeat(15000);document.body.append(filler);});
  await call({op:'capture_clear'});const tooLarge=await call({op:'observe',cursor:0,limit:100});const photo=tooLarge.snapshot.targets.find(t=>t.name==='Photo');
  const denied=await call({op:'capture_mask',snapshotId:tooLarge.snapshot.snapshotId,targetId:photo.id});assert.equal(denied.code,'capture_redaction_incomplete');
  console.log('PASS: outside movement allowed; entering/moving private fields, new iframes, explicit redactions, target movement, scroll, resize and expiry fail closed.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
