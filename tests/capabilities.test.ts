import test from 'node:test';
import assert from 'node:assert/strict';
import {actionSchema,observationDiff,type ObservationV2,type TargetV2} from '../src/capabilities.js';

test('typed actions reject generic code, secrets, extra fields and unbounded input',()=>{
  assert.equal(actionSchema.safeParse({type:'fill',targetId:'r2',value:'Ondřej'}).success,true);
  assert.equal(actionSchema.safeParse({type:'click',targetId:'r1',javascript:'alert(1)'}).success,false);
  assert.equal(actionSchema.safeParse({type:'key',targetId:'r1',key:'arbitrary command'}).success,false);
  assert.equal(actionSchema.safeParse({type:'replace',targetId:'r1',start:10,end:0,text:'x'}).success,false);
  assert.equal(actionSchema.safeParse({type:'scroll',targetId:'r1',y:1000000}).success,false);
});
test('delta distinguishes stable-node changes, additions and removed refs',()=>{
  const target=(id:string,name:string):TargetV2=>({id,name,role:'button',kind:'button',disabled:false,readonly:false,visible:true});
  const snapshot=(id:string,targets:TargetV2[]):ObservationV2=>({schemaVersion:2,snapshotId:id,epoch:1,origin:'https://example.com',path:'/',title:'Test',targets,coverage:{scanned:10,targetCount:targets.length,truncated:false,cursor:0,nextCursor:null},provenance:{source:'page',trust:'untrusted',documentToken:'doc'}});
  const delta=observationDiff(snapshot('a',[target('r0','Old'),target('r1','Removed')]),snapshot('b',[target('r0','Changed'),target('r2','New')]));
  assert.equal(delta.baseSnapshotId,'a');assert.deepEqual(delta.removed,['r1']);assert.deepEqual(delta.added.map(t=>t.id),['r2']);assert.deepEqual(delta.changed.map(t=>t.id),['r0']);
});
