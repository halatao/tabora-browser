import { createServer } from 'node:http';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { runAdapter } from '../src/host/adapters.js';
import type { DecisionRequest } from '../src/shared.js';
const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const root=await mkdtemp(path.join(base,'sdk-'));
// This process is a synthetic test only; SDKs must not read the user's config.
for(const key of Object.keys(process.env))if(!['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP'].includes(key))delete process.env[key];
Object.assign(process.env,{HOME:root,USERPROFILE:root,APPDATA:root,LOCALAPPDATA:root,DISABLE_NONESSENTIAL_TRAFFIC:'1'});
const request:DecisionRequest={requestId:'sdk-fixture',stateVersion:'doc-1',question:'Choose continue.',context:{button:'Continue'},choices:[{id:'continue',description:'Continue'},{id:'ask_user',description:'Ask user'}]};
const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),30000);
let codexCalls=0,claudeCalls=0;
const text='{"choiceId":"continue"}';
const item={id:'msg_test',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
const response={id:'resp_test',object:'response',created_at:0,status:'completed',model:'fixture-model',output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15,output_tokens_details:{reasoning_tokens:0}}};
const server=createServer(async(req,res)=>{
  if(!req.url?.startsWith('/v1/messages')){res.writeHead(404).end();return;}
  let data='';for await(const chunk of req)data+=chunk;
  const body=JSON.parse(data);claudeCalls++;
  assert((body.tools??[]).every((t:any)=>t.name==='StructuredOutput'));
  const structured=(body.tools??[]).some((t:any)=>t.name==='StructuredOutput');
  const content=structured?[{type:'tool_use',id:'tool_test',name:'StructuredOutput',input:{choiceId:'continue'}}]:[{type:'text',text}];
  const message={id:'msg_test',type:'message',role:'assistant',model:body.model,content,stop_reason:structured?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:5}};
  if(!body.stream){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(message));return;}
  const events=[{type:'message_start',message:{...message,content:[],stop_reason:null,usage:{input_tokens:10,output_tokens:0}}},
    {type:'content_block_start',index:0,content_block:structured?{type:'tool_use',id:'tool_test',name:'StructuredOutput',input:{}}:{type:'text',text:''}},
    {type:'content_block_delta',index:0,delta:structured?{type:'input_json_delta',partial_json:text}:{type:'text_delta',text}},
    {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:{output_tokens:5}},{type:'message_stop'}];
  res.writeHead(200,{'content-type':'text/event-stream'});for(const e of events)res.write('event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n');res.end();
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=server.address() as {port:number};process.env.ANTHROPIC_BASE_URL=`http://127.0.0.1:${address.port}`;
try{
  const result=await runAdapter(request,{provider:'codex-sdk',model:'fixture-model',timeoutMs:30000},'FAKE',path.join(root,'codex-run'),controller,async(_url,init)=>{
    codexCalls++;const body=JSON.parse(init!.body as string);assert.deepEqual(body.tools,[]);assert.equal(body.tool_choice,'none');
    const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},
      {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},
      {type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},
      {type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:text},
      {type:'response.output_text.done',item_id:item.id,output_index:0,content_index:0,text},
      {type:'response.content_part.done',item_id:item.id,output_index:0,content_index:0,part:item.content[0]},
      {type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}];
    return new Response(events.map((e,i)=>'event: '+e.type+'\ndata: '+JSON.stringify({...e,sequence_number:i})+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
  });
  assert.equal(result.choiceId,'continue');assert(codexCalls>0);console.log('PASS: real Codex SDK + CLI → guarded proxy → synthetic API response.');
  const claude=await runAdapter(request,{provider:'claude-sdk',model:'claude-sonnet-4-6',timeoutMs:30000},'FAKE',path.join(root,'claude-run'),controller);
  assert.equal(claude.choiceId,'continue');assert(claudeCalls>0);console.log('PASS: real Claude Agent SDK → local synthetic Messages endpoint; external tools absent.');
}finally{
  clearTimeout(timer);controller.abort();server.closeAllConnections();server.close();assert.equal(path.dirname(root),base);await rm(root,{recursive:true,force:true,maxRetries:5});
}
