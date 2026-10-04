import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { NativeDecoder, encodeMessage } from '../src/host/codec.js';
import { Vault, type KeyProtector } from '../src/host/vault.js';
import { exactOrigin, parseChoice, requestSchema, decisionGuidance, decisionPrompt, MAX_MESSAGE, type DecisionRequest } from '../src/shared.js';
import { withoutTools, guardResponseEvent, createCodexProxy } from '../src/host/codex-proxy.js';
import { jevDecision } from '../src/host/adapters.js';
import { summarize } from '../src/benchmark.js';

const request:DecisionRequest={requestId:'one',stateVersion:'doc-1',question:'Which button?',context:{label:'Continue'},choices:[{id:'continue',description:'Continue'},{id:'ask_user',description:'Ask user'}]};
test('decision boundary rejects unknown choices, extra fields and duplicate candidates',()=>{
  assert.equal(parseChoice({choiceId:'continue'},request),'continue');
  assert.throws(()=>parseChoice({choiceId:'delete'},request));
  assert.throws(()=>parseChoice({choiceId:'continue',script:'bad'},request));
  assert.throws(()=>requestSchema.parse({...request,choices:[request.choices[0],request.choices[0]]}));
});
test('native protocol handles fragmentation and batched messages',()=>{
  const d=new NativeDecoder(),a=encodeMessage({hello:'Ahoj 👋'}),b=encodeMessage({next:2});
  assert.deepEqual(d.push(a.subarray(0,2)),[]);
  assert.deepEqual(d.push(Buffer.concat([a.subarray(2),b])),[{hello:'Ahoj 👋'},{next:2}]);
  const invalid=Buffer.alloc(4);invalid.writeUInt32LE(MAX_MESSAGE+1);assert.throws(()=>d.push(invalid));
});
test('origins are exact; credentials require HTTPS',()=>{
  assert.equal(exactOrigin('https://example.com/login?token=secret',true),'https://example.com');
  for(const url of ['http://example.com','https://user:pass@example.com','javascript:alert(1)'])assert.throws(()=>exactOrigin(url,true));
  assert.notEqual(exactOrigin('https://example.com.evil.test',true),exactOrigin('https://example.com',true));
});
test('vault encrypts, authenticates, scopes and serializes; locking removes access',async()=>{
  const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const dir=await mkdtemp(path.join(base,'vault-'));
  // Test OS protector: opaque handles resolve only inside this test process.
  const keys=new Map<string,Buffer>();
  const protector:KeyProtector={protect:async b=>{const id=randomBytes(16);keys.set(id.toString('hex'),Buffer.from(b));return id;},unprotect:async b=>Buffer.from(keys.get(b.toString('hex'))!)};
  const file=path.join(dir,'vault.json'),vault=new Vault(file,protector);
  try {
    assert.throws(()=>vault.list());await vault.unlock();
    const secret='FAKE-test-secret-"quoted"';
    const [id]=await Promise.all([vault.put({kind:'website',label:'Test',origin:'https://example.com/login',username:'tester',secret}),vault.put({kind:'provider',provider:'typesafe-jev',secret:'FAKE-api-key'})]);
    assert.equal(vault.list().length,2);assert(!JSON.stringify(vault.list()).includes(secret));
    assert.equal(vault.websiteSecret(id,'https://example.com').password,secret);
    assert.throws(()=>vault.websiteSecret(id,'https://example.com.evil.test'));
    assert.deepEqual(vault.redact({text:'prefix '+secret+' suffix',n:1}),{text:'prefix [REDACTED] suffix',n:1});
    const disk=await readFile(file,'utf8');assert(!disk.includes(secret));assert(!disk.includes('tester'));
    vault.lock();assert.throws(()=>vault.providerSecret('typesafe-jev'));await vault.unlock();assert.equal(vault.list().length,2);
    vault.lock();const tampered=JSON.parse(disk);tampered.tag=Buffer.alloc(16).toString('base64');await writeFile(file,JSON.stringify(tampered));
    await assert.rejects(vault.unlock());assert(vault.locked);
  }finally{vault.lock();assert.equal(path.dirname(dir),base);await rm(dir,{recursive:true,force:true});}
});
test('vault refuses stale writes from another native host without losing entries',async()=>{
  const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const dir=await mkdtemp(path.join(base,'vault-race-'));
  const keys=new Map<string,Buffer>();
  const protector:KeyProtector={protect:async b=>{const id=randomBytes(16);keys.set(id.toString('hex'),Buffer.from(b));return id;},unprotect:async b=>Buffer.from(keys.get(b.toString('hex'))!)};
  const first=new Vault(path.join(dir,'vault.json'),protector),second=new Vault(path.join(dir,'vault.json'),protector);
  try {
    await first.unlock();await second.unlock();
    await first.put({kind:'provider',provider:'codex-sdk',secret:'FAKE-first'});
    await assert.rejects(second.put({kind:'provider',provider:'claude-sdk',secret:'FAKE-second'}),{message:'vault_changed'});
    assert(second.locked);await second.unlock();assert.equal(second.providerSecret('codex-sdk'),'FAKE-first');
    await second.put({kind:'provider',provider:'claude-sdk',secret:'FAKE-second'});
    first.lock();await first.unlock();assert.equal(first.list().length,2);
  }finally{first.lock();second.lock();assert.equal(path.dirname(dir),base);await rm(dir,{recursive:true,force:true});}
});
test('Codex proxy removes every offered tool and rejects tool output',()=>{
  const body=withoutTools({tools:[{type:'function',name:'shell'}],tool_choice:'auto',model:'test'});
  assert.deepEqual(body.tools,[]);assert.equal(body.tool_choice,'none');assert.equal(body.store,false);
  guardResponseEvent({type:'response.output_item.added',item:{type:'message'}});
  assert.throws(()=>guardResponseEvent({type:'response.output_item.added',item:{type:'function_call',name:'shell'}}));
  assert.throws(()=>guardResponseEvent({type:'response.completed',response:{output:[{type:'custom_tool_call'}]}}));
});
test('Codex proxy forwards only authenticated responses requests without tools',async()=>{
  let forwarded:any;
  const proxy=await createCodexProxy('FAKE-key',new AbortController().signal,async(url,init)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');forwarded=JSON.parse(init!.body as string);
    return new Response('data: {"type":"response.output_item.added","item":{"type":"message"}}\n\n',{headers:{'content-type':'text/event-stream'}});
  });
  try {
    assert.equal((await fetch(proxy.url+'/responses',{method:'POST',body:'{}'})).status,403);
    const result=await fetch(proxy.url+'/responses',{method:'POST',headers:{authorization:'Bearer '+proxy.token},body:JSON.stringify({model:'fixture',tools:[{type:'function',name:'shell'}]})});
    assert.equal(result.status,200);assert((await result.text()).includes('message'));assert.deepEqual(forwarded.tools,[]);
    assert.equal((await fetch(proxy.url+'/models',{headers:{authorization:'Bearer '+proxy.token}})).status,403);
  }finally{proxy.close();}
});
test('Jev uses native choice schema and rejects a provider-selected foreign ID',async()=>{
  const config={provider:'typesafe-jev' as const,model:'fixture-model',timeoutMs:30000};
  const mock:typeof fetch=async(url,init)=>{
    assert.equal(url,'https://api.typesafe.ai/v1/systemone');const sent=JSON.parse(init!.body as string);
    assert.deepEqual(Object.keys(sent.questions.next.criteria),['continue','ask_user']);assert.equal(sent.questions.next.type,'choice');
    return Response.json({model:'fixture-model',answers:{next:{type:'choice',choice:'continue',confidence:0.9}},usage:{input_tokens:10,output_tokens:1}});
  };
  assert.equal((await jevDecision(request,config,'FAKE',new AbortController().signal,mock)).choiceId,'continue');
  await assert.rejects(jevDecision(request,config,'FAKE',new AbortController().signal,async()=>Response.json({model:'fixture',answers:{next:{type:'choice',choice:'attack',confidence:1}},usage:{input_tokens:1,output_tokens:1}})));
});

test('Jev and SDK guidance preserve escalation criteria after inspect is removed',async()=>{
  const retrieval={...request,question:'Find the inventory count',choices:[{id:'reports',description:'Click Reports (menu contains Inventory)'},{id:'ask_user',description:'A required user parameter, credential or authorization is missing.'}]};
  for(const choices of [retrieval.choices,[...retrieval.choices,{id:'inspect',description:'Read page body'}]]){
    const next={...retrieval,choices},guidance=decisionGuidance(next);
    assert(guidance.includes('only according to its supplied description'));assert(guidance.includes('Uncertainty alone does not meet a criterion'));
    assert(!guidance.includes('if uncertain'));assert(!guidance.includes('insufficient choose ask_user'));
    assert(decisionPrompt(next).includes(guidance));
    await jevDecision(next,{provider:'typesafe-jev',model:'fixture-model',timeoutMs:30000},'FAKE',new AbortController().signal,async(_url,init)=>{
      const sent=JSON.parse(init!.body as string);assert(sent.questions.next.instructions.endsWith(guidance));
      assert.equal(sent.questions.next.criteria.ask_user,retrieval.choices[1].description);
      return Response.json({model:'fixture-model',answers:{next:{type:'choice',choice:'reports',confidence:0.9}},usage:{input_tokens:10,output_tokens:1}});
    });
  }
});
test('authenticated SDK proxy preserves SDK headers, narrows the envelope and accepts SSE without MIME',async()=>{
  let count=0;
  const proxy=await createCodexProxy('',new AbortController().signal,async(url,init)=>{
    count++;assert.equal(url,'https://chatgpt.com/backend-api/codex/responses');
    assert.equal((init!.headers as Record<string,string>).authorization,'Bearer FAKE-sdk-login');assert.equal((init!.headers as Record<string,string>).originator,'codex_cli_rs');
    const sent=JSON.parse(init!.body as string);assert.equal(sent.input.length,1);assert.deepEqual(sent.tools,[]);assert(!JSON.stringify(sent).includes('PRIVATE_INSTRUCTIONS'));
    return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"type":"response.output_item.added","item":{"type":"message"}}\r'));c.enqueue(new TextEncoder().encode('\n\r\n'));c.close();}}));
  },{request,model:'fixture',sdkUpstream:'https://chatgpt.com/backend-api/codex/responses'});
  try{
    const response=await fetch(proxy.url+'/responses',{method:'POST',headers:{authorization:'Bearer FAKE-sdk-login',originator:'codex_cli_rs'},body:JSON.stringify({model:'fixture',stream:true,input:[{type:'additional_tools',tools:[{name:'shell'}]},{role:'user',content:'PRIVATE_INSTRUCTIONS'}]})});
    assert.equal(response.status,200);assert((await response.text()).includes('message'));assert.equal(count,1);assert.equal(proxy.failureCode,undefined);assert.equal(proxy.envelopeStats?.embeddedToolsRemoved,1);
    assert.equal((await fetch(proxy.url+'/responses',{method:'POST',headers:{authorization:'Bearer FAKE-sdk-login',origin:'https://evil.test'},body:'{}'})).status,403);assert.equal(count,1);
  }finally{proxy.close();}
});
test('benchmark never rewards fast failures or unknown prices',()=>{
  const base={requestId:'x',stateVersion:'1',provider:'codex-sdk' as const,model:'fixture'};
  const s=summarize([
    {provider:base.provider,model:'fixture',sample:0,expectedChoiceId:'continue',result:{...base,status:'failed',code:'unavailable',latencyMs:0}},
    {provider:base.provider,model:'fixture',sample:1,expectedChoiceId:'continue',result:{...base,status:'selected',choiceId:'continue',latencyMs:200,costUsd:0.1}},
  ])[0];
  assert.equal(s.p50,200);assert.equal(s.p95,200);assert.equal(s.correct,1);assert.equal(s.scored,2);assert.equal(s.costUsd,null);
});
