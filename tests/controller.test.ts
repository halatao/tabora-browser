import test from 'node:test';
import assert from 'node:assert/strict';
import {RunController,answerFacts,relevantFacts} from '../src/host/run-controller.js';
import {decisionEnvelope} from '../src/host/codex-proxy.js';
import {PilotError,type Snapshot,type DecisionRequest} from '../src/shared.js';
test('observed select choices apply a filter without finishing from stale totals',async()=>{
  const controller=new RunController();let stage=0;
  const page:Snapshot={...snapshot,title:'Entries',text:'10 records found',dataVersion:'unfiltered',targets:[
    {id:'status',kind:'select',name:'State',options:[{label:'Any',index:0,placeholder:true,selected:true,disabled:false},{label:'Accepted',index:1,selected:false,disabled:false},{label:'Forbidden',index:2,selected:false,disabled:true}]},
    {id:'apply',kind:'button',name:'Search'}, {id:'body',kind:'text',name:'Page body'}]};
  let current=page;
  const run=controller.start('owner','profile','filter','typesafe-jev','Get total number of Accepted entries',async(command,payload:any)=>{
    if(command==='status')return {binding};if(command==='observe')return {snapshot:current};
    if(command==='select'){
      assert(!payload.request.choices.some((c:any)=>c.description.includes('Forbidden')));
      assert(payload.request.choices.length<=60);
      if(stage<2)assert(!payload.request.choices.some((c:any)=>c.id.startsWith('finish_')),'No answer before applied result');
      return {status:'selected',choiceId:stage===0?'option_status_1':stage===1?'apply':payload.request.choices.find((c:any)=>c.id.startsWith('finish_')).id,latencyMs:0};
    }
    if(command==='manual'){
      if(stage===0){assert.equal(payload.recipe,'fill');assert.equal(payload.selectOptionIndex,1);assert.equal(payload.fields,undefined);}else assert.equal(payload.recipe,'click');
      return {actionId:crypto.randomUUID()};
    }
    if(command==='step'){
      stage++;
      current=stage===1?{...page,pageVersion:'selected',targets:[{...page.targets[0],options:page.targets[0].options!.map(o=>({...o,selected:o.index===1}))},...page.targets.slice(1)]}:{...current,text:'3 records found',pageVersion:'applied',dataVersion:'filtered'};
      return {action:{filled:1,verified:true},snapshot:current,binding,readiness:{state:'observed'}};
    }
    throw Error('Unexpected');
  },{maxSteps:5,timeoutMs:5000,readonly:false});
  const result=await completed(controller,'owner',run.id);assert.equal(result.answer,'3');assert.equal(stage,2);
});

test('readonly controller never offers select mutations',async()=>{
  const controller=new RunController();let checked=false;
  const page:Snapshot={...snapshot,targets:[{id:'s',kind:'select',name:'State',options:[{label:'Ready',index:0,selected:false,disabled:false}]},...snapshot.targets]};
  const run=controller.start('owner','profile','readonly','typesafe-jev','Read data',async(command,payload:any)=>{
    if(command==='status')return {binding};if(command==='observe')return {snapshot:page};
    if(command==='select'){assert(!payload.request.choices.some((c:any)=>c.id.startsWith('option_')));checked=true;return {status:'failed',code:'fixture_complete'};}
    throw Error('No mutation expected');
  },{maxSteps:2,timeoutMs:5000,readonly:true});
  await completed(controller,'owner',run.id);assert(checked);
});
const binding={tabId:1,documentId:'document-1',origin:'https://fixture.test'};
const snapshot:Snapshot={documentToken:'token-1',origin:binding.origin,path:'/dashboard',pageVersion:'1',title:'Dashboard',targets:[
  {id:'e0',kind:'table',name:'Term | Uses',section:'Last Search Terms',preview:[['Term','Uses'],['wrong','99']],previewTruncated:false},
  {id:'e1',kind:'table',name:'Term | Uses',section:'Top Search Terms',preview:[['Term','Uses'],['second','1'],['first','10']],previewTruncated:false},
  {id:'e2',kind:'text',name:'Page body'}]};
test('answers carry distinct section evidence, aggregate completeness and page totals',()=>{
  const facts=answerFacts(snapshot,binding);
  assert(facts.some(f=>f.value==='first'&&f.evidence.section==='Top Search Terms'&&f.evidence.description.includes('highest Uses = 10')));
  assert(!answerFacts({...snapshot,targets:[{...snapshot.targets[1],previewTruncated:true}]},binding).some(f=>f.evidence.description.includes('highest')));
  assert(answerFacts({...snapshot,text:'5 items found'},binding).some(f=>f.value==='5'&&f.evidence.description.includes('Explicit total count')));
});
test('wire boundary strips inherited instructions and BOTH tool encodings',()=>{
  const request:DecisionRequest={requestId:'1',stateVersion:'1',question:'Choose',context:{},choices:[{id:'a',description:'A'},{id:'b',description:'B'}]};
  const body=decisionEnvelope({model:'model',instructions:'Personal instruction',tools:[{name:'exec'}],input:[{type:'additional_tools',tools:[{name:'exec'}]},{role:'user',content:'AGENTS private instruction'}],text:{format:{type:'text'}},stream:true},request,'model');
  assert.deepEqual(body.tools,[]);assert.equal(body.tool_choice,'none');assert.equal(body.store,false);
  assert.equal(body.input.length,1);assert(!JSON.stringify(body).includes('Personal instruction'));assert(!JSON.stringify(body).includes('AGENTS'));assert(!JSON.stringify(body).includes('additional_tools'));
  assert.deepEqual(body.text.format.schema.properties.choiceId.enum,['a','b']);
  assert.throws(()=>decisionEnvelope({model:'substitute'},request,'model'));
});
test('candidate answers reject unrelated dashboard data, preserve explicit totals and normalize currency',()=>{
  assert.deepEqual(relevantFacts('Get total number of Pending reviews',answerFacts(snapshot,binding)),[]);
  const pending={...snapshot,title:'Pending Reviews',text:'5 records found'};
  const count=relevantFacts('Get total number of Pending reviews',answerFacts(pending,binding));assert.equal(count[0].value,'5');assert.equal(count[0].evidence.complete,true);
  const invoice={...snapshot,targets:[{id:'e0',kind:'table' as const,name:'Invoices',preview:[['Invoice','Grand Total'],['000000001','$36.39']],previewTruncated:false}]};
  const facts=relevantFacts('Grand total of invoice 000000001',answerFacts(invoice,binding));assert(facts.some(f=>f.value==='36.39'&&f.evidence.description.includes('Grand Total')));
  assert.deepEqual(relevantFacts('Grand total of invoice 000000002',answerFacts(invoice,binding)),[]);
});
async function completed(controller:RunController,owner:string,id:string){for(let i=0;i<100;i++){const status=controller.status(owner,id);if(status.status!=='running')return status;await new Promise(r=>setTimeout(r,5));}throw new Error('Run did not finish');}

test('goal-relevant navigation and late submenu labels survive choice bounds',async()=>{
  const controller=new RunController();
  const labels=Array.from({length:20},(_,i)=>'Unrelated navigation label '+i);
  const menu={id:'menu',kind:'button' as const,name:'Inventory',contains:[...labels,'Pending stock'],containsTruncated:true};
  const page={...snapshot,targets:[...Array.from({length:35},(_,i)=>({id:'n'+i,kind:'link' as const,name:'Unrelated '+i})),menu,{id:'body',kind:'text' as const,name:'Page body'}]};
  let validated=false;
  const run=controller.start('owner','profile','session','typesafe-jev','Get Pending stock',async(command,payload:any)=>{
    if(command==='status')return {binding};if(command==='observe')return {snapshot:page};
    if(command==='select'){
      const choice=payload.request.choices.find((c:any)=>c.id==='menu');
      assert(choice);assert(choice.description.includes('partial: Pending stock'));assert(choice.description.length<=300);
      assert.deepEqual(payload.request.context.page.targets.find((t:any)=>t.id==='menu').contains,menu.contains);
      validated=true;return {status:'failed',code:'fixture_complete'};
    }
    throw new Error('Unexpected action');
  },{maxSteps:2,timeoutMs:5000,readonly:false});
  await completed(controller,'owner',run.id);assert(validated);
});

test('obscured pre-dispatch targets trigger a fresh decision with bounded recovery',async()=>{
  const controller=new RunController();let decisions=0,observations=0,attempts=0;
  const page={...snapshot,targets:[{id:'click',kind:'button' as const,name:'Open inventory'},{id:'body',kind:'text' as const,name:'Page body'}]};
  const run=controller.start('owner','profile','session','typesafe-jev','Inventory',async(command)=>{
    if(command==='status')return {binding};if(command==='observe'){observations++;return {snapshot:page};}
    if(command==='select'){decisions++;return {status:'selected',choiceId:'click',latencyMs:0};}
    if(command==='manual')return {actionId:crypto.randomUUID()};
    if(command==='step'){attempts++;throw new PilotError('target_obscured');}
    throw new Error('Unexpected');
  },{maxSteps:10,timeoutMs:5000,readonly:false});
  const result=await completed(controller,'owner',run.id);
  assert.equal(result.code,'target_obscured');assert.equal(attempts,3);assert.equal(decisions,3);assert.equal(observations,3);
});
test('local controller delivers a grounded Jev choice answer without a second model',async()=>{
  const controller=new RunController();let decisions=0;
  const call=async(command:string,payload:any)=>{
    if(command==='status')return {binding};if(command==='observe')return {snapshot};
    if(command==='select'){decisions++;const choice=payload.request.choices.find((c:any)=>c.description.includes('highest Uses = 10'));return {status:'selected',choiceId:choice.id,latencyMs:1};}
    throw new Error('Unexpected action');
  };
  const run=controller.start('owner','profile','session','typesafe-jev','Top Search Terms most used term',call,{maxSteps:5,timeoutMs:5000,readonly:false});
  assert.throws(()=>controller.status('different-owner',run.id));
  const result=await completed(controller,'owner',run.id);assert.equal(result.answer,'first');assert.equal(result.status,'completed');assert.equal(result.evidence?.section,'Top Search Terms');assert.equal(decisions,1);
  await new Promise(r=>setTimeout(r,10));assert.equal(controller.status('owner',run.id).elapsedMs,result.elapsedMs);
});
test('ask_user gets one bounded inspection; unknown click outcomes are never replayed',async()=>{
  const controller=new RunController();let inspections=0;
  const run=controller.start('owner','profile','session','typesafe-jev','Unknown',async(command,payload:any)=>{
    if(command==='status')return {binding};if(command==='observe')return {snapshot};
    if(command==='select'){
      const inspected=payload.request.choices.some((c:any)=>c.id==='ask_user');
      if(inspected){assert(!payload.request.choices.some((c:any)=>c.id==='inspect'));assert(!payload.request.choices.some((c:any)=>c.id===snapshot.targets.find(t=>t.kind==='text')?.id));}
      return {status:'selected',choiceId:inspected?'ask_user':'inspect',latencyMs:0};
    }
    if(command==='manual'){inspections++;return {actionId:crypto.randomUUID()};}
    if(command==='step')return {action:{text:'No evidence',truncated:false},snapshot,binding,readiness:{state:'observed'}};
    throw new Error('Unexpected');
  },{maxSteps:5,timeoutMs:5000,readonly:false});
  const result=await completed(controller,'owner',run.id);assert.equal(result.status,'needs_input');assert.equal(inspections,1);
  let writes=0;
  const clickSnapshot={...snapshot,targets:[{id:'e0',kind:'button' as const,name:'Open menu'},{id:'e1',kind:'text' as const,name:'Page body'}]};
  const uncertain=controller.start('owner','profile','session','codex-sdk','Open',async command=>{
    if(command==='status')return {binding};if(command==='observe')return {snapshot:clickSnapshot};if(command==='select')return {status:'selected',choiceId:'e0',latencyMs:0};if(command==='manual')return {actionId:crypto.randomUUID()};
    if(command==='step'){writes++;return {action:{outcome:'unknown'},snapshot:clickSnapshot,binding,readiness:{state:'timeout'}};}
    throw new Error('Unexpected');
  },{maxSteps:5,timeoutMs:5000,readonly:false});
  const failure=await completed(controller,'owner',uncertain.id);assert.equal(failure.code,'action_outcome_unknown');assert.equal(writes,1);
});
test('unchanged reads are removed but a new page revision makes them available again',async()=>{
  const controller=new RunController();let decisions=0,operations=0,reads=0;
  const initial={...snapshot,pageVersion:'a',targets:[{id:'e0',kind:'text' as const,name:'Page body'},{id:'e1',kind:'button' as const,name:'Open menu'}]};
  let current=initial;
  const run=controller.start('owner','profile','session','typesafe-jev','Unknown',async(command,payload:any)=>{
    if(command==='status')return {binding};if(command==='observe')return {snapshot:current};
    if(command==='select'){
      decisions++;
      const choices=payload.request.choices;
      if(decisions===2){assert(!choices.some((c:any)=>['inspect','e0'].includes(c.id)));return {status:'selected',choiceId:'e1',latencyMs:0};}
      if(decisions===3)assert(choices.some((c:any)=>c.id==='inspect'));
      return {status:'selected',choiceId:decisions===4?'ask_user':'inspect',latencyMs:0};
    }
    if(command==='manual'){if(payload.recipe==='extract')reads++;return {actionId:crypto.randomUUID()};}
    if(command==='step'){operations++;if(operations===2)current={...initial,pageVersion:'b'};return {action:{text:'No evidence',truncated:false},snapshot:current,binding,readiness:{state:'observed'}};}
    throw new Error('Unexpected');
  },{maxSteps:5,timeoutMs:5000,readonly:false});
  assert.equal((await completed(controller,'owner',run.id)).status,'needs_input');assert.equal(reads,2);assert.equal(operations,3);
});

test('profile cancellation and active-run exclusivity prevent later actions',async()=>{
  const controller=new RunController();let resolve!:(value:any)=>void,operations=0;
  const run=controller.start('owner','profile','session','codex-sdk','Find',async command=>{
    if(command==='status')return {binding};if(command==='observe')return {snapshot};if(command==='select')return new Promise(r=>{resolve=r;});if(command==='cancel')return {};operations++;return {};
  },{maxSteps:3,timeoutMs:5000,readonly:false});
  assert.throws(()=>controller.start('owner','profile','session','codex-sdk','Find',async()=>{}, {maxSteps:3,timeoutMs:5000,readonly:false}));
  for(let i=0;!resolve&&i<100;i++)await new Promise(r=>setTimeout(r,5));assert(resolve);controller.cancelProfile('profile');resolve({status:'selected',choiceId:'e1'});
  assert.equal((await completed(controller,'owner',run.id)).status,'cancelled');assert.equal(operations,0);
});
