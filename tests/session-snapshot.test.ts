import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserSession} from '../src/extension/session.js';
import type {DecisionRequest} from '../src/shared.js';

test('decision provider receives a refreshed recipe snapshot after an interleaved V2 observation',async()=>{
  const original=globalThis.chrome,origin='https://fixture.test';
  let serial=0,clicked=0,label='Old photo',documentId='document-one',outcome='unverified';
  const requests:any[]=[];
  const browser={
    permissions:{contains:async(input:any)=>!input.permissions},
    tabs:{get:async()=>({id:1,windowId:1,url:origin,status:'complete',active:false,discarded:false})},
    windows:{get:async()=>({state:'normal',focused:false})},
    webNavigation:{getAllFrames:async()=>[{frameId:0,parentFrameId:-1,documentId,url:origin}]},
    scripting:{executeScript:async(input:any)=>{
      if(input.files)return [];
      const op=input.args?.[0];let result:any;
      if(!op)result=input.func.toString().includes('globalThis.origin')?{url:origin,origin}:origin;
      else if(op.op==='observe')result={ok:true,fullSnapshot:true,snapshot:{schemaVersion:2,snapshotId:'snapshot-'+(++serial),origin,path:'/',title:'Fixture',dataVersion:String(serial),epoch:0,provenance:{source:'page',trust:'untrusted',documentToken:'sensor-one'},coverage:{cursor:0,nextCursor:null,truncated:false},targets:[{id:'r1',kind:'button',name:label,visible:true,disabled:false}]}};
      else if(op.op==='action'){clicked++;result={ok:true,dispatch:'sent',outcome};}
      else throw new Error('Unexpected sensor operation: '+op.op);
      return [{result,documentId,frameId:0}];
    }},
  };
  Object.defineProperty(globalThis,'chrome',{value:browser,configurable:true});
  const session=createBrowserSession('test','Snapshot regression',true,async(command,payload)=>{
    if(command!=='decide')return {};
    const {request}=payload as {request:DecisionRequest};requests.push(request);
    return {status:'selected',choiceId:'r1',requestId:request.requestId,stateVersion:request.stateVersion};
  });
  const decide=()=>session.invoke('decide',{recipe:'click',provider:'codex-sdk',question:'Open the photo'});
  try{
    await session.invoke('pin',{tabId:1});
    await session.invoke('v2.state',{frameId:0,cursor:0,limit:100});
    await assert.rejects(session.invoke('manual',{recipe:'click',targetId:'not-observed'}),/observe_first/);
    label='Renamed control';await assert.rejects(session.invoke('manual',{recipe:'click',targetId:'r1'}),/stale_snapshot/);
    await session.invoke('v2.state',{frameId:0,cursor:0,limit:100});
    const bridged=await session.invoke('manual',{recipe:'click',targetId:'r1'});assert.equal(bridged.manual,true);assert(bridged.actionId);
    await session.invoke('observe',{recipe:'all'});
    const v2=await session.invoke('v2.state',{frameId:0,cursor:0,limit:100});
    label='Current photo';
    const chosen=await decide();
    assert.equal(requests[0].context.targets[0].name,'Current photo');
    assert.notEqual(requests[0].stateVersion,v2.stateVersion);
    assert.equal((await session.invoke('execute',{actionId:chosen.actionId})).dispatch,'sent');
    assert.equal(clicked,1);

    await session.invoke('observe',{recipe:'all'});
    const stale=await decide();
    await session.invoke('v2.state',{frameId:0,cursor:0,limit:100});
    await assert.rejects(session.invoke('execute',{actionId:stale.actionId}),/stale_snapshot/);
    assert.equal(clicked,1,'Do not silently rebase an action after the provider selected it');

    const unknown=await decide();outcome='unknown';
    await assert.rejects(session.invoke('execute',{actionId:unknown.actionId}),/action_outcome_unknown/);
    assert.equal(clicked,2,'An ambiguous write must be dispatched only once');

    await session.invoke('observe',{recipe:'all'});
    await session.invoke('v2.state',{frameId:0,cursor:0,limit:100});
    const before=requests.length;
    await assert.rejects(session.invoke('decide',{recipe:'fill',provider:'codex-sdk',question:'Select the option',selectOptionIndex:1}),/stale_snapshot/);
    assert.equal(requests.length,before,'Do not reinterpret an index supplied against a stale menu');
    documentId='document-two';
    await assert.rejects(decide(),/stale_binding/);
    assert.equal(requests.length,before,'A changed document must not be silently rebound');
  }finally{Object.defineProperty(globalThis,'chrome',{value:original,configurable:true});}
});
