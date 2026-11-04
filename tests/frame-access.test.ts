import test from 'node:test';
import assert from 'node:assert/strict';
import {frameAccess} from '../src/extension/frame-access.js';

test('frame admission requires verified effective origin, exact document and both grants',async()=>{
  const original=globalThis.chrome,origin='https://fixture.test';
  let granted=true,probe:any={url:'about:blank',origin},fail=false,documentId='doc',frameId=7;
  const calls:any[]=[];
  Object.defineProperty(globalThis,'chrome',{configurable:true,value:{
    permissions:{contains:async()=>granted},
    scripting:{executeScript:async(input:any)=>{calls.push(input);if(fail)throw new Error('injection failed');return [{documentId,frameId,result:probe}];}},
  }});
  const frame={frameId:7,parentFrameId:0,documentId:'doc',url:'about:blank'} as chrome.webNavigation.GetAllFrameResultDetails;
  try{
    const inherited=await frameAccess(1,frame,[origin]);assert.equal(inherited.allowed,true);assert.equal(inherited.origin,origin);
    assert.deepEqual(calls[0].target,{tabId:1,documentIds:['doc']});assert.equal(calls[0].world,'ISOLATED');
    probe={url:frame.url,origin:'null'};assert.equal((await frameAccess(1,frame,[origin])).reason,'frame_opaque_origin');
    probe={url:frame.url,origin:'https://foreign.test'};assert.equal((await frameAccess(1,frame,[origin])).reason,'frame_origin_not_granted');
    probe={url:frame.url,origin};granted=false;
    const denied=await frameAccess(1,frame,[origin]);assert.equal(denied.allowed,false);assert.equal(denied.missingPermission,origin+'/*');
    granted=true;documentId='replaced';assert.equal((await frameAccess(1,frame,[origin])).reason,'frame_origin_unverified');
    documentId='doc';frameId=8;assert.equal((await frameAccess(1,frame,[origin])).reason,'frame_origin_unverified');
    frameId=7;probe={url:'https://changed.test',origin};assert.equal((await frameAccess(1,frame,[origin])).reason,'frame_origin_unverified');
    fail=true;assert.equal((await frameAccess(1,frame,[origin])).reason,'frame_origin_probe_failed');
    const webFrame={...frame,url:origin+'/child'};granted=false;
    const failure=await frameAccess(1,webFrame,[origin]);assert.equal(failure.origin,null);assert.equal(failure.urlOrigin,origin);assert.equal(failure.reason,'site_permission_required');assert.equal(failure.missingPermission,origin+'/*');
  }finally{Object.defineProperty(globalThis,'chrome',{value:original,configurable:true});}
});
