import test from 'node:test';
import assert from 'node:assert/strict';
import {legacyRecipes} from '../src/extension/legacy-recipes.js';
import {PilotError} from '../src/shared.js';

function fixture(code='overlapping_table_cells'){
  const reads:string[]=[];
  const recipes=legacyRecipes(async(name,input)=>{
    if(name==='state')return {stateVersion:'document:snapshot',snapshot:{snapshotId:'snapshot',origin:'https://fixture.test',path:'/',dataVersion:'1',provenance:{documentToken:'document'},coverage:{nextCursor:null,truncated:false},targets:[
      {id:'table',kind:'grid',name:'Malformed grid'},
      {id:'save',kind:'button',name:'Save'},
      {id:'reply',kind:'textbox',name:'Reply'},
    ]}};
    if(name==='read'){reads.push(input.targetId);throw new PilotError(code);}
    throw new Error('Unexpected operation '+name);
  });
  return {recipes,reads};
}

test('click and fill preparation do not read unrelated tables',async()=>{
  for(const [kind,id] of [['click','save'],['fill','reply']]){
    const {recipes,reads}=fixture();
    const menu=await recipes.observeForTarget(kind,id);
    assert.equal(menu.snapshot.targets[0].id,id);
    assert.deepEqual(reads,[]);
  }
});

test('malformed previews remain explicit while exact extraction still rejects them',async()=>{
  for(const code of ['overlapping_table_cells','incomplete_table_layout']){
    const {recipes}=fixture(code);
    const menu=await recipes.observeForTarget('all');
    const table=menu.snapshot.targets.find(target=>target.id==='table')!;
    assert.equal(table.previewError,code);
    assert.equal(table.previewTruncated,true);
    assert.equal(table.preview,undefined);
    assert(menu.snapshot.targets.some(target=>target.id==='save'));
    await assert.rejects(recipes.operation({op:'execute',origin:'https://fixture.test',token:menu.snapshot.documentToken,targetId:'table',recipe:'extract'}),new RegExp(code));
  }
});

test('preview handling does not swallow permission or stale-document failures',async()=>{
  for(const code of ['site_permission_required','stale_snapshot','data_not_exportable']){
    await assert.rejects(fixture(code).recipes.observeForTarget('all'),new RegExp(code));
  }
});
