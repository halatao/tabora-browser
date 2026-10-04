import test from 'node:test';
import assert from 'node:assert/strict';
import {listAnswerFacts} from '../src/host/run-controller.js';
import type {Snapshot,Binding} from '../src/shared.js';
const binding={documentId:'doc',tabId:1,origin:'https://example.test'} as Binding;
const snapshot:Snapshot={documentToken:'token',origin:binding.origin,path:'/',targets:[{id:'table',kind:'table',name:'Inventory',preview:[['Product','Stock','Sales'],['Alpha','0','99'],['Beta','2','20'],['Gamma','3','10'],['Delta','1','5']]}]};
test('ranked lists project observed columns and explicit numeric filters without invented values',()=>{
 const facts=listAnswerFacts('Get top 2 products in stock',snapshot,binding);
 const filtered=facts.find(f=>f.evidence.description.includes('descending Sales, only rows with Stock > 0'));
 assert.deepEqual(filtered?.values,['Beta','Gamma']);
 assert(facts.every(f=>f.values?.every(v=>snapshot.targets[0].preview!.slice(1).some(row=>row.includes(v)))));
});
test('partial, malformed and tied rankings do not claim complete answers',()=>{
 assert.deepEqual(listAnswerFacts('top 2 products',{...snapshot,targets:[{...snapshot.targets[0],previewTruncated:true}]},binding),[]);
 const tied={...snapshot,targets:[{...snapshot.targets[0],preview:[['Product','Sales'],['A','20'],['B','10'],['C','10']]}]};
 assert.deepEqual(listAnswerFacts('top 2 products',tied,binding),[]);
 assert.deepEqual(listAnswerFacts('top 0 products',snapshot,binding),[]);
});
test('first and last lists preserve explicit row order and scalar tasks get no list candidates',()=>{
 assert.deepEqual(listAnswerFacts('first 2 products',snapshot,binding)[0].values,['Alpha','Beta']);
 assert.deepEqual(listAnswerFacts('last 2 products',snapshot,binding)[0].values,['Delta','Gamma']);
 assert.deepEqual(listAnswerFacts('get invoice total',snapshot,binding),[]);
});
test('explicitly ranked tables keep displayed order instead of re-ranking by an unrelated metric',()=>{
 const ranked={...snapshot,targets:[{...snapshot.targets[0],name:'Top Products'}]};
 const facts=listAnswerFacts('top 2 products',ranked,binding);
 assert(facts.every(f=>!f.evidence.description.includes('descending')));
 assert.deepEqual(facts[0].values,['Alpha','Beta']);
 assert(facts.some(f=>f.values?.join(',')==='Beta,Gamma'&&f.evidence.description.includes('Stock > 0')));
});
import {RunController} from '../src/host/run-controller.js';
test('run status retains a list and its compatible string answer with document evidence',async()=>{
 const controller=new RunController();
 const run=controller.start('owner','profile','session','typesafe-jev','first 2 products',async(command,payload:any)=>{
  if(command==='status')return {binding};
  if(command==='observe')return {snapshot};
  if(command==='select')return {status:'selected',choiceId:payload.request.choices.find((c:any)=>c.id.startsWith('finish_')&&c.description.includes('Alpha')&&c.description.includes('Beta')).id,latencyMs:1};
  throw Error('unexpected write '+command);
 },{maxSteps:2,timeoutMs:1000,readonly:true,task:true});
 for(let i=0;i<100&&controller.status('owner',run.id).status==='running';i++)await new Promise(r=>setTimeout(r,5));
 const status=controller.status('owner',run.id);
 assert.equal(status.status,'completed');assert.deepEqual(status.answerValues,['Alpha','Beta']);
 assert.equal(status.answer,'["Alpha","Beta"]');assert.equal(status.evidence?.documentId,'doc');
});
