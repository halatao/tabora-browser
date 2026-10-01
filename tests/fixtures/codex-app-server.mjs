import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
let sequence=0,threadId='',turnId='',choice='';
const mode=process.env.FIXTURE_MODE??'success';
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const notify=(method,params)=>send({method,params});
for await(const line of createInterface({input:process.stdin})){
  const {id,method,params}=JSON.parse(line);if(id===undefined)continue;
  if(method==='initialize')send({id,result:{userAgent:'fixture'}});
  else if(method==='account/read')send({id,result:{account:{type:'chatgpt'},requiresOpenaiAuth:true}});
  else if(method==='model/list')send({id,result:{data:[{model:'fixture-model',displayName:'Fixture',isDefault:true}],nextCursor:null}});
  else if(method==='config/read')send({id,result:{config:{mcp_servers:{'inherited.server':{enabled:true,env:{SECRET:'never forward this value'}}},plugins:{'fixture@marketplace':{enabled:true}}}}});
  else if(method==='thread/start'){
    assert.equal(params.ephemeral,true);assert.equal(params.approvalPolicy,'never');assert.equal(params.sandbox,'read-only');
    assert.deepEqual(params.dynamicTools,[]);assert.deepEqual(params.environments,[]);assert(params.baseInstructions.length<500);
    assert.deepEqual(params.config,{model_reasoning_effort:'low',mcp_servers:{'inherited.server':{enabled:false}},plugins:{'fixture@marketplace':{enabled:false}}});
    threadId=`thread-${++sequence}`;send({id,result:{thread:{id:threadId},model:mode==='wrong-model'?'substituted-model':params.model}});
  }else if(method==='mcpServerStatus/list'){
    assert.equal(params.threadId,threadId);
    send({id,result:{data:[{runtimeStatus:mode==='active-mcp'?'connected':'disabled',tools:mode==='mcp-tools'?{unexpected:{}}:{}}],nextCursor:null}});
  }else if(method==='turn/start'){
    assert.equal(params.threadId,threadId);assert.equal(params.effort,'low');
    choice=params.outputSchema.properties.choiceId.enum[0];turnId=`turn-${sequence}`;
    if(mode==='rpc-error'){send({id,error:{code:-1,message:'Do not expose this provider diagnostic'}});continue;}
    if(mode==='exit'){process.exit(1);}
    notify('turn/started',{threadId,turn:{id:turnId}});
    if(mode==='hang'){send({id,result:{turn:{id:turnId}}});continue;}
    if(mode==='tool'){notify('item/started',{threadId,turnId,item:{type:'commandExecution'}});continue;}
    if(mode==='approval'){send({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId,turnId}});continue;}
    // Ignore unrelated threads/turns and handle completion arriving before the RPC reply.
    notify('item/completed',{threadId:'old-thread',turnId,item:{type:'agentMessage',text:'{"choiceId":"wrong"}'}});
    notify('item/completed',{threadId,turnId:'old-turn',item:{type:'agentMessage',text:'{"choiceId":"wrong"}'}});
    notify('thread/tokenUsage/updated',{threadId,turnId,tokenUsage:{last:{inputTokens:100,outputTokens:8,cachedInputTokens:50,reasoningOutputTokens:2}}});
    notify('item/completed',{threadId,turnId,item:{type:'agentMessage',text:JSON.stringify({choiceId:mode==='invalid-choice'?'not-supplied':choice})}});
    notify('turn/completed',{threadId,turn:{id:turnId,status:'completed',items:[]}});
    send({id,result:{turn:{id:turnId}}});
  }else if(method==='thread/unsubscribe')send({id,result:{status:'unsubscribed'}});
  else send({id,error:{code:-32601,message:'Unknown fixture method'}});
}
