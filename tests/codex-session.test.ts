import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {CodexDecisionSession} from '../src/host/codex-session.js';
import {PilotError,type DecisionRequest} from '../src/shared.js';
const request:DecisionRequest={requestId:'test',stateVersion:'1',question:'Choose the matching option.',context:{},choices:[{id:'first',description:'First'},{id:'second',description:'Second'}]};
function fixture(mode='success'){
  return new CodexDecisionSession({cwd:process.cwd(),executable:process.execPath,prefixArgs:[path.resolve('tests/fixtures/codex-app-server.mjs')],env:{FIXTURE_MODE:mode,...Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]!]))}});
}
const code=(expected:string)=>(error:unknown)=>error instanceof PilotError&&error.code===expected;
test('persistent Codex process handles sequential isolated turns, early events, correlation and cached usage',async()=>{
  const session=fixture();
  try{
    const first=await session.decide(request,'test-model',AbortSignal.timeout(5000));
    const second=await session.decide({...request,stateVersion:'2',choices:[...request.choices].reverse()},'test-model',AbortSignal.timeout(5000));
    assert.equal(first.choiceId,'first');assert.equal(second.choiceId,'second');
    assert.equal(first.diagnostics?.coldStart,true);assert.equal(second.diagnostics?.coldStart,false);
    assert.equal(first.diagnostics?.processId,second.diagnostics?.processId);
    assert.deepEqual(second.usage,{input:100,output:8,cachedInput:50,reasoningOutput:2});
    assert.equal(second.diagnostics?.disabledMcpServers,1);assert.equal(second.diagnostics?.disabledPlugins,1);assert.equal(second.diagnostics?.mcpTools,0);
  }finally{await session.close();}
});
for(const [mode,expected]of [['invalid-choice','invalid_response'],['wrong-model','unexpected_model'],['tool','tool_call_blocked'],['approval','tool_call_blocked'],['rpc-error','app_server_request_failed'],['exit','session_closed'],['active-mcp','integration_isolation_failed'],['mcp-tools','integration_isolation_failed']]){
  test(`Codex session rejects ${mode} and closes the failed session`,async()=>{
    const session=fixture(mode);
    try{
      await assert.rejects(session.decide(request,'test-model',AbortSignal.timeout(5000)),code(expected));
      await assert.rejects(session.decide(request,'test-model',AbortSignal.timeout(5000)),code(expected));
    }finally{await session.close();}
  });
}
test('abort during startup; overlapping requests cannot corrupt correlation',async()=>{
  const session=fixture('hang'),controller=new AbortController();
  try{
    const pending=session.decide(request,'test-model',controller.signal);
    await assert.rejects(session.decide(request,'test-model',AbortSignal.timeout(5000)),code('session_busy'));
    controller.abort();await assert.rejects(pending,code('cancelled'));
  }finally{await session.close();}
});
test('timeout closes a process that never completes its turn',async()=>{
  const session=fixture('hang');
  try{await assert.rejects(session.decide(request,'test-model',AbortSignal.timeout(1500)),code('cancelled'));}
  finally{await session.close();}
});

test('Codex catalog reads account and model metadata without starting an inference turn',async()=>{
 const session=fixture();try{const result=await session.catalog();assert.equal(result.state,'connected');assert.deepEqual(result.models,[{id:'fixture-model',label:'Fixture',isDefault:true}]);}finally{await session.close();}
});
