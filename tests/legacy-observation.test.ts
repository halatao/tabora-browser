import test from 'node:test';
import assert from 'node:assert/strict';
import {legacyRecipes} from '../src/extension/legacy-recipes.js';
import type {TargetV2} from '../src/capabilities.js';
import {PilotError,safeErrorDetails} from '../src/shared.js';

const target=(id:string,kind='button',name=id):TargetV2=>({id,kind,role:kind,name,visible:true,disabled:false,readonly:false});
test('both compatibility and V2 stale-state failures have bounded recovery guidance',()=>{
  for(const code of ['stale_snapshot','stale_reference','stale_continuation','observe_first','decision_expired'])assert.deepEqual(safeErrorDetails(new PilotError(code)),{blockers:[],phase:'actionability',dispatch:'not_sent',nextStep:'observe'});
  assert.equal(safeErrorDetails(new PilotError('untrusted_code')),undefined);
});
function fixture(initial:TargetV2[]){
  let targets=initial,revision=0;const actions:any[]=[];
  const call=async(name:string,input:any):Promise<any>=>{
    if(name==='state'){
      const snapshotId=String(++revision);
      return {stateVersion:'document:'+snapshotId,snapshot:{snapshotId,origin:'https://example.com',path:'/',title:'Fixture',dataVersion:'text',provenance:{documentToken:'sensor'},coverage:{nextCursor:null,truncated:false},targets}};
    }
    if(name==='read')return {text:'Fixture'};
    if(name==='plan'){actions.push(input.action);return {actionId:'plan',stateVersion:input.stateVersion};}
    if(name==='commit')return {action:{dispatch:'sent',outcome:'verified'}};
    throw Error(name);
  };
  return {api:legacyRecipes(call),actions,change:(next:TargetV2[])=>{targets=next;}};
}
test('legacy menus expose all bounded targets through scoped continuations',async()=>{
  const f=fixture(Array.from({length:113},(_,i)=>target('r'+i)));
  const a=await f.api.operation({op:'observe',kind:'click'});
  assert.equal(a.snapshot.targets.length,48);assert.equal(a.stateVersion,a.snapshot.stateVersion);assert(a.nextCursor);
  const b=await f.api.operation({op:'observe',kind:'click',cursor:a.nextCursor});
  assert.equal(b.snapshot.targets[0].id,'r48');assert(b.nextCursor);
  await assert.rejects(f.api.operation({op:'observe',kind:'click',cursor:a.nextCursor}),/stale_continuation/);
  const c=await f.api.operation({op:'observe',kind:'click',cursor:b.nextCursor});
  assert.equal(c.snapshot.targets.length,17);assert.equal(c.nextCursor,null);assert.equal(c.snapshot.truncated,false);
});
test('continuation rejects another recipe and a changed target sequence',async()=>{
  const f=fixture(Array.from({length:55},(_,i)=>target('r'+i)));
  const a=await f.api.operation({op:'observe',kind:'click'});
  await assert.rejects(f.api.operation({op:'observe',kind:'fill',cursor:a.nextCursor}),/stale_continuation/);
  f.change([target('other'),...Array.from({length:55},(_,i)=>target('r'+i))]);
  await assert.rejects(f.api.operation({op:'observe',kind:'click',cursor:a.nextCursor}),/stale_continuation/);
});
test('legacy click menus retain checkbox semantics and checked state',async()=>{
  const f=fixture([{...target('consent','checkbox','Consent'),checked:false}]);
  const observed=await f.api.operation({op:'observe',kind:'click'});
  assert.deepEqual(observed.snapshot.targets,[{id:'consent',kind:'checkbox',name:'Consent',checked:false,disabled:false,section:undefined}]);
});
test('fields already covered by an observed form are not duplicated in legacy menus',async()=>{
  const f=fixture([target('form','form','Contact'),{...target('inside','textbox','Name'),formId:'form'},target('outside','textbox','Notes')]);
  const observed=await f.api.operation({op:'observe',kind:'fill'});
  assert.deepEqual(observed.snapshot.targets.map((t:any)=>[t.id,t.kind]),[['form','form'],['outside','field']]);
  assert.deepEqual(observed.snapshot.targets[0].fields,['Name']);
});
test('standalone fields can be filled by exact identity even when names repeat',async()=>{
  const f=fixture([target('r1','textbox','Name'),target('r2','textbox','Name'),{...target('r3','textbox','Password'),secret:true}]);
  const observed=await f.api.operation({op:'observe',kind:'fill'});
  assert.deepEqual(observed.snapshot.targets.map((t:any)=>t.id),['r1','r2']);
  assert.equal(observed.snapshot.targets[0].kind,'field');
  const result=await f.api.operation({op:'execute',origin:'https://example.com',token:observed.snapshot.documentToken,targetId:'r2',recipe:'fill',fields:{Name:'Chosen'}});
  assert.equal(result.filled,1);assert.deepEqual(f.actions,[{type:'fill',targetId:'r2',value:'Chosen',backend:'dom'}]);
});
