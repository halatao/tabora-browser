import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {requestSchema,imageDecisionCapability} from '../src/shared.js';
import {decisionEnvelope} from '../src/host/codex-proxy.js';
import {claudeDecisionInput,runAdapter} from '../src/host/adapters.js';
import {RunController} from '../src/host/run-controller.js';
import {workflowSchema} from '../src/browser-api.js';

const image={data:'YWJjZA==',mimeType:'image/jpeg' as const,width:100,height:100,captureId:randomUUID(),targetId:'r1',stateVersion:'d:s',expiresAt:Date.now()+60000};
const request={requestId:'r',stateVersion:'d:s',question:'Which observed control matches this image?',context:{},choices:[{id:'first',description:'First control'},{id:'second',description:'Second control'}],images:[image]};
test('bounded image envelope binds its state and never accepts remote URLs or arbitrary fields',()=>{
  requestSchema.parse(request);
  for(const images of [[{...image,stateVersion:'other:s'}],[{...image,data:'https://example.com/private'}],[{...image,data:'a'.repeat(160004)}],[{...image,path:'C:/private'}],[image,image]])assert(!requestSchema.safeParse({...request,images}).success);
});
test('wire guard forwards exactly the authorized image and strips inherited tools and images',()=>{
  const result=decisionEnvelope({model:'gpt-5.5',input:[{type:'input_image',image_url:'unrequested'}],tools:[{type:'function'}]},request,'gpt-5.5') as any;
  assert.deepEqual(result.tools,[]);assert.equal(result.tool_choice,'none');
  assert.equal(result.input[0].content.length,2);assert.equal(result.input[0].content[1].image_url,'data:image/jpeg;base64,YWJjZA==');
  assert(!JSON.stringify(result).includes('unrequested'));assert(!JSON.stringify(result.input[0].content[0]).includes('YWJjZA=='));
});
test('Claude receives a real image block; Jev cannot silently treat base64 as visual evidence',async()=>{
  const input=await claudeDecisionInput(request).next();const content=input.value!.message.content as any[];
  assert.equal(content[1].type,'image');assert.deepEqual(content[1].source,{type:'base64',media_type:'image/jpeg',data:image.data});
  assert.equal(imageDecisionCapability({provider:'typesafe-jev',model:'jev-latest',timeoutMs:30000}).status,'unsupported');
  await assert.rejects(runAdapter(request,{provider:'typesafe-jev',model:'jev-latest',timeoutMs:30000},'', '.',new AbortController()),/provider_vision_unsupported/);
});
test('default native workflow fails explicitly before decision or write when permission is absent',async()=>{
  const controller=new RunController(),commands:string[]=[];
  const run=controller.start('owner','profile','session','typesafe-jev','Save',async command=>{commands.push(command);if(command==='v2.capabilities')return {capabilities:{nativeInput:{status:'permission_required'}}};throw Error(command);},{readonly:false,maxSteps:3,timeoutMs:2000,workflow:workflowSchema.parse({success:{name:'Receipt',contains:'Saved'}})});
  await new Promise(resolve=>setTimeout(resolve,10));const status=controller.status('owner',run.id);
  assert.equal(status.code,'native_input_permission_required');assert.deepEqual(commands,['v2.capabilities']);
});
test('capability negotiation selects native before write and explicit DOM opt-out remains compatible',async()=>{
  for(const native of [undefined,false]){
    let saved=false;const controller=new RunController();
    const run=controller.start('owner','profile','session','typesafe-jev','Save',async(command,p:any)=>{
      if(command==='v2.capabilities')return {capabilities:{nativeInput:{status:'available'},capture:{status:'available'}}};
      if(command==='v2.frames')return {frames:[{frameId:0,allowed:true}]};
      if(command==='v2.state')return {stateVersion:'d:s',binding:{documentId:'d'},snapshot:{schemaVersion:2,snapshotId:'s',origin:'https://example.test',path:'/',provenance:{source:'page',trust:'untrusted',documentToken:'t'},coverage:{nextCursor:null},targets:[{id:'save',kind:'button',name:'Save',visible:true},{id:'receipt',name:'Receipt',kind:'status',visible:true}]}};
      if(command==='v2.read')return {text:saved?'Saved':'Ready',complete:true};
      if(command==='select')return {status:'selected',choiceId:p.request.choices.find((choice:any)=>choice.description.startsWith('Activate button')).id,latencyMs:1,model:'fixture'};
      if(command==='v2.plan'){assert.equal(p.action.backend,native===false?'dom':'native');return {actionId:'action',stateVersion:'d:s'};}
      if(command==='v2.commit'){saved=true;return {action:{dispatch:'sent',outcome:'unverified'}};}throw Error(command);
    },{readonly:false,maxSteps:4,timeoutMs:2000,workflow:workflowSchema.parse({nativeInput:native,success:{name:'Receipt',contains:'Saved'}})});
    for(let i=0;i<50&&controller.status('owner',run.id).status==='running';i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(controller.status('owner',run.id).status,'completed');assert(saved);
  }
});
