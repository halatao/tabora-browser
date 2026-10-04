import test from 'node:test';
import assert from 'node:assert/strict';
import {GoalPlan} from '../src/host/goal-plan.js';
import type {TargetV2} from '../src/capabilities.js';
const target=(id:string,kind:string,name:string,extra:Partial<TargetV2>={}):TargetV2=>({id,kind,role:kind,name,visible:true,disabled:false,readonly:false,...extra});
const frames=(targets:TargetV2[],truncated=false)=>[{frameId:0,state:{stateVersion:'doc:s',binding:{documentId:'doc',origin:'https://fixture.test'},snapshot:{schemaVersion:2 as const,snapshotId:'s',epoch:1,origin:'https://fixture.test',path:'/',title:'fixture',targets,coverage:{scanned:targets.length,targetCount:targets.length,truncated,cursor:0,nextCursor:null},provenance:{source:'page' as const,trust:'untrusted' as const,documentToken:'token'}}}}];
test('checkbox goals ground all controls and verify values without another decision',()=>{
  const plan=new GoalPlan('Check all checkboxes.');const before=frames([target('a','checkbox','Consent',{checked:false}),target('b','checkbox','Updates',{checked:true})]);
  assert.equal(plan.evaluate(before),false);assert.equal(plan.operations(before,false).length,1);
  assert.equal(plan.evaluate(frames(before[0].state.snapshot.targets.map(t=>({...t,checked:true})))),true);
  assert.equal(plan.evaluate(frames(before[0].state.snapshot.targets,true)),false);
  assert.throws(()=>plan.operations(before,true),/readonly_mode/);
});
test('select/fill predicates refuse ambiguity and secret fields',()=>{
  const plan=new GoalPlan('Select Green in the dropdown.');const select=target('s','combobox','Colour',{options:[{label:'Green',index:2,selected:false,disabled:false}]});
  assert.equal(plan.operations(frames([select]),false)[0].action?.type,'select');
  assert.throws(()=>plan.evaluate(frames([select,{...select,id:'s2'}])),/ambiguous_target/);
  const fill=new GoalPlan('Replace the editor text with "Public text".');
  assert.equal(fill.operations(frames([target('password','textbox','Password',{secret:true})]),false).length,0);
  assert.equal(fill.evaluate(frames([target('editor','textbox','Editor',{value:'Public text'})])),true);
});
test('ordered repeated actions require actual dispatch and final count, not just the final DOM',()=>{
  const plan=new GoalPlan('Click Create twice, then delete one item. Finish with exactly one Delete button remaining.');
  let page=frames([target('create','button','Create'),target('delete','button','Delete')]);
  assert.equal(plan.evaluate(page),false);
  const operation=plan.operations(page,false)[0];
  plan.record(operation.action!,page[0].state.snapshot.targets[0],'unknown','unknown');assert.equal(plan.evaluate(page),false);
  plan.record(operation.action!,page[0].state.snapshot.targets[0],'sent','verified');
  plan.record(operation.action!,page[0].state.snapshot.targets[0],'sent','verified');
  const deletion=plan.operations(page,false)[0];assert.equal(deletion.action?.targetId,'delete');
  plan.record(deletion.action!,page[0].state.snapshot.targets[1],'sent','verified');assert.equal(plan.evaluate(page),true);
});
test('unknown writes cannot be synthesized from webpage text or an unsupported public goal',()=>{
  assert.throws(()=>new GoalPlan('Transfer money and finish'),/unsupported_intent/);
  assert.throws(()=>new GoalPlan('Click Transfer and finish'),/unsupported_intent/);
});
test('absence receipts reject old, negative, unrelated and incomplete evidence',()=>{
 const goal='Click Dismiss and wait until the checkbox disappears and the page confirms that it has been removed.';
 const plan=new GoalPlan(goal),before=frames([target('dismiss','button','Dismiss'),target('box','checkbox','Agreement'),target('body','generic','Page body')]);
 assert.equal(plan.confirmationReads(before).length,1);plan.confirmAbsence(before[0], 'The checkbox has been removed.');
 const after=frames([target('body','generic','Page body')]);assert.equal(plan.confirmAbsence(after[0],'Checkbox removed successfully.'),undefined);
 plan.record({type:'click',targetId:'dismiss',backend:'dom'},before[0].state.snapshot.targets[0],'sent','verified');
 for(const text of ['The checkbox has been removed.','The checkbox has not been removed.','If removed, a receipt appears.','Order deleted.'])assert.equal(plan.confirmAbsence(after[0],text),undefined);
 assert.equal(plan.confirmAbsence(after[0],'Checkbox removed successfully.'),'Checkbox removed successfully.');
 assert.throws(()=>plan.confirmationReads(frames(after[0].state.snapshot.targets,true)),/incomplete_observation/);
});

test('late checkbox rendering becomes an obligation and incomplete scope cannot dispatch',()=>{
  const plan=new GoalPlan('Check all checkboxes.');
  assert.equal(plan.evaluate(frames([target('a','checkbox','Agreement',{checked:false})])),false);
  assert.equal(plan.evaluate(frames([target('a','checkbox','Agreement',{checked:true}),target('b','checkbox','Updates',{checked:false})])),false);
  assert.throws(()=>plan.operations(frames([target('a','checkbox','Agreement')],true),false),/incomplete_observation/);
});
