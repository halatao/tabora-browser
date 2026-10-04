import test from 'node:test';
import assert from 'node:assert/strict';
import {answerFacts,relevantFacts} from '../src/host/evidence-facts.js';
import {decisionEnvelope} from '../src/host/codex-proxy.js';
import type {Snapshot,DecisionRequest} from '../src/shared.js';
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
