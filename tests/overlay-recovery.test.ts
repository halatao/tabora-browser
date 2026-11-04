import test from 'node:test';
import assert from 'node:assert/strict';
import {overlayRecovery} from '../src/host/overlay-recovery.js';
import type {ObservedFrame} from '../src/host/goal-plan.js';
import {workflowChoices} from '../src/host/candidate-service.js';
import {workflowSchema} from '../src/browser-api.js';
const diagnostic={blockers:[{tag:'DIV',id:'notice',className:'',role:'dialog',name:'Service notice'}],dispatch:'not_sent' as const};
function frame(extra:any[]=[]):ObservedFrame{return {frameId:0,state:{stateVersion:'doc:snapshot',snapshot:{targets:[{id:'dialog',kind:'dialog',visible:true,name:'Service notice'},{id:'close',kind:'button',visible:true,name:'Close',section:'Service notice'},...extra]}}} as any;}
test('only a uniquely observed informational close is offered as a separate recovery action',()=>{
  const candidates=overlayRecovery([frame()],diagnostic);assert.equal(candidates.length,1);assert.deepEqual(candidates[0].action,{type:'click',targetId:'close',backend:'dom'});
  assert.deepEqual(overlayRecovery([frame()],{...diagnostic,dispatch:'unknown'}),[]);
  assert.deepEqual(overlayRecovery([frame()],{...diagnostic,blockers:[]}),[]);
  for(const extra of [
    [{id:'field',kind:'textbox',name:'Unsaved input',section:'Service notice'}],
    [{id:'auth',kind:'button',name:'Confirm payment',section:'Service notice'}],
    [{id:'close2',kind:'button',visible:true,name:'Dismiss',section:'Service notice'}],
    [{id:'secret',kind:'generic',secret:true,section:'Service notice'}],
  ])assert.deepEqual(overlayRecovery([frame(extra)],diagnostic),[]);
});

test('stalled paint keeps semantic keyboard choices and excludes unsupported pointer choices',()=>{
  const snapshot=frame().state.snapshot,workflow=workflowSchema.parse({nativeInput:true,success:{name:'Receipt',contains:'Saved'}});
  const native=workflowChoices(snapshot,workflow,false,false);
  assert(native.some(choice=>choice.action?.type==='key'&&choice.action.key==='Enter'));
  assert(!native.some(choice=>choice.action&&['click','hover','drag'].includes(choice.action.type)));
  assert(workflowChoices(snapshot,{...workflow,nativeInput:false},false,false).some(choice=>choice.action?.type==='click'&&choice.action.backend==='dom'));
});
