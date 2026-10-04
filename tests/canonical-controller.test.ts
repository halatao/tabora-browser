import test from 'node:test';
import assert from 'node:assert/strict';
import {RunController} from '../src/host/run-controller.js';
import {fixture,control} from './controller-fixture.js';
import {PilotError} from '../src/shared.js';
import {workflowSchema} from '../src/browser-api.js';
async function terminal(controller:RunController,id:string){for(let i=0;i<300;i++){const result=controller.status('owner',id);if(result.status!=='running')return result;await new Promise(r=>setTimeout(r,5));}throw Error('Run did not terminate');}
const options={readonly:false,maxSteps:5,timeoutMs:1000};
test('absence confirmation requires the actual authorized action, absent control and a new affirmative receipt',async()=>{
  for(const initial of ['',"It's gone!"]){
    const f=fixture([control('remove','button','Remove'),control('box','checkbox','Consent'),control('body','generic','Page body')],initial);
    f.hooks.decision=async()=>({status:'selected',choiceId:'op_0',latencyMs:0});
    let writes=0;f.hooks.commit=async()=>{writes++;f.targets.splice(1,1);f.setText("It's gone!");return {action:{dispatch:'sent',outcome:'verified'}};};
    const c=new RunController(),run=c.start('owner','profile','s','typesafe-jev','Click Remove and wait until the checkbox disappears and the page confirms that it is gone.',f.call,{...options,timeoutMs:1500});
    const result=await terminal(c,run.id);assert.equal(writes,1);assert.equal(result.status,initial?'failed':'completed');
  }
});
test('shadow paragraph retrieval uses structural provenance, not flattened page lines',async()=>{
  const f=fixture([control('body','generic','Page body'),control('p1','paragraph','',{shadowRootPath:[1]}),control('p2','paragraph','',{shadowRootPath:[2]})]);
  const reads:string[]=[];f.hooks.read=async input=>{reads.push(input.targetId);assert.equal(input.targetId,'p1');return {text:'Independent shadow value',complete:true,truncated:false,nextOffset:null,provenance:{documentToken:'token'}};};
  f.hooks.decision=async input=>{assert(input.request.choices.find((c:any)=>c.id==='finish_0').description.includes('shadow root 1'));return {status:'selected',choiceId:'finish_0',latencyMs:0};};
  const c=new RunController(),run=c.start('owner','profile','s','typesafe-jev','Read the paragraph in the first shadow root and return its text.',f.call,options);
  const result=await terminal(c,run.id);assert.equal(result.status,'completed');assert.equal(result.answer,'Independent shadow value');assert.deepEqual(reads,['p1']);
});
test('raw-goal fill is literal-bound, document-bound and completes without submit or another model',async()=>{
  const f=fixture([control('field','textbox','Comment',{value:''})]);let calls=0;
  f.hooks.decision=async input=>{calls++;assert(input.request.choices.some((c:any)=>c.description.includes('fill')));return {status:'selected',choiceId:'op_0',latencyMs:1,model:'actual-model'};};
  f.hooks.commit=async()=>{assert.equal(f.action?.type,'fill');f.targets[0].value='Blue notebook';return {action:{dispatch:'sent',outcome:'verified'}};};
  const c=new RunController(),run=c.start('owner','profile','s','typesafe-jev','Fill Comment with "Blue notebook".',f.call,{...options,maxSteps:1}),result=await terminal(c,run.id);
  assert.equal(result.status,'completed');assert.equal(calls,1);assert.equal(result.metrics?.decisions,1);assert.equal(result.metrics?.actions,1);assert.equal(result.phase,'terminal');assert.equal(result.trace[0].model,'actual-model');assert(!f.commands.some(command=>['observe','manual','step'].includes(command)));
});
test('raw check, select and value completion use fresh V2 state and never repeat a successful write',async()=>{
  for(const [goal,target] of [['Check all checkboxes.',control('box','checkbox','Agreement',{checked:false})],['Select Violet in the dropdown.',control('s','combobox','Colour',{options:[{index:0,label:'Violet',selected:false,disabled:false}]})]] as const){
    const f=fixture([target]);let commits=0;f.hooks.decision=async()=>({status:'selected',choiceId:'op_0',latencyMs:0});
    f.hooks.commit=async()=>{commits++;target.checked=true;if(target.options)target.options[0].selected=true;return {action:{dispatch:'sent',outcome:'verified'}};};
    const c=new RunController(),run=c.start('owner','profile','s','codex-sdk',goal,f.call,options);assert.equal((await terminal(c,run.id)).status,'completed');assert.equal(commits,1);
  }
});
test('readonly raw-goal input rejects writes before observation or decision',async()=>{
  const f=fixture([control('s','checkbox','Consent')]);const c=new RunController(),run=c.start('owner','profile','s','codex-sdk','Check all checkboxes.',f.call,{...options,readonly:true});
  assert.equal((await terminal(c,run.id)).code,'readonly_mode');assert.equal(f.commands.length,0);
});
test('unknown public intent fails precisely without inventing a credential or dispatching',async()=>{
  const f=fixture([]);const c=new RunController(),run=c.start('owner','profile','s','codex-sdk','Do something unspecified',f.call,options);
  assert.equal((await terminal(c,run.id)).code,'unsupported_intent');assert.equal(f.commands.length,0);
});
test('obscured pre-dispatch control can recover; unknown click dispatch cannot be replayed',async()=>{
  for(const uncertain of [false,true]){
    const f=fixture([control('go','button','Launch'),control('body','generic','Page body')]);let commits=0,plans=0;
    const call=async(command:string,input:any)=>{if(command==='v2.plan'&&!uncertain&&plans++===0)throw new PilotError('target_obscured');return f.call(command,input);};
    f.hooks.decision=async()=>({status:'selected',choiceId:'op_0',latencyMs:0});
    f.hooks.commit=async()=>{commits++;if(!uncertain)f.setText('Complete');return {action:{dispatch:uncertain?'unknown':'sent',outcome:uncertain?'unknown':'verified'}};};
    const c=new RunController(),run=c.start('owner','profile','s','codex-sdk','Click Launch and wait until Complete becomes visible.',call,{...options,timeoutMs:2000,maxSteps:8});
    const result=await terminal(c,run.id);assert.equal(commits,1);assert.equal(result.status,uncertain?'failed':'completed');if(uncertain)assert.equal(result.code,'action_outcome_unknown');
  }
});
test('cancellation interrupts an unresolved browser call, preserves ownership and prevents future actions',async()=>{
  const c=new RunController(),calls:string[]=[];const run=c.start('owner','profile','s','codex-sdk','Read the page',async command=>{calls.push(command);if(command==='cancel')return {};return new Promise(()=>{});},options);
  assert.throws(()=>c.start('owner','profile','s','codex-sdk','Read',async()=>{},options),/run_active/);
  c.cancelProfile('profile');const result=await terminal(c,run.id);assert.equal(result.status,'cancelled');assert(!calls.includes('v2.commit'));assert.throws(()=>c.status('foreign',run.id),/run_not_owned/);
});
test('filter workflow waits for supplied success evidence instead of answering stale page data',async()=>{
  const field=control('s','combobox','State',{options:[{index:1,label:'Accepted',selected:false,disabled:false}]}),receipt=control('body','region','Results');const f=fixture([field,control('apply','button','Apply'),receipt]);let stage=0;
  f.hooks.read=async()=>({text:stage<2?'10 results':'3 accepted results',complete:true});
  f.hooks.decision=async input=>({status:'selected',choiceId:input.request.choices.find((choice:any)=>choice.description.includes(stage===0?'Set State':'Activate button: Apply')).id,latencyMs:0});
  f.hooks.commit=async()=>{stage++;if(stage===1)field.options![0].selected=true;return {action:{dispatch:'sent',outcome:'verified'}};};
  const c=new RunController(),run=c.start('owner','profile','s','codex-sdk','Get accepted results',f.call,{...options,workflow:workflowSchema.parse({nativeInput:false,values:[{field:'State',value:'Accepted'}],success:{name:'Results',contains:'3 accepted'}})});const result=await terminal(c,run.id);assert.equal(result.status,'completed');assert.equal(stage,2);
});

test('observation scope is never silently truncated before completion',async()=>{
  const f=fixture([control('a','checkbox','Agreement',{checked:true})]);
  const call=async(command:string,input:any)=>command==='v2.frames'?{frames:Array.from({length:17},(_,frameId)=>({frameId,allowed:true}))}:f.call(command,input);
  const c=new RunController(),run=c.start('owner','profile','s','typesafe-jev','Check all checkboxes.',call,options);
  assert.equal((await terminal(c,run.id)).code,'observation_scope_limit');assert(!f.commands.includes('select'));
});

test('pending enable transition is verified without asking the model to hand off or spending another decision',async()=>{
  const field=control('f','textbox','',{value:'',disabled:true}),enable=control('e','button','Enable');
  const f=fixture([field,enable]);let decisions=0;f.hooks.decision=async()=>{decisions++;return {status:'selected',choiceId:'op_0',latencyMs:0};};
  f.hooks.commit=async()=>{if(f.action?.type==='click'){enable.disabled=true;setTimeout(()=>{field.disabled=false;enable.name='Disable';},300);}else field.value='Public text';return {action:{dispatch:'sent',outcome:'verified'}};};
  const c=new RunController(),run=c.start('owner','profile','s','typesafe-jev','Enable the disabled input and enter "Public text" into it.',f.call,{...options,maxSteps:2,timeoutMs:3000});
  const result=await terminal(c,run.id);assert.equal(result.status,'completed');assert.equal(decisions,2);assert.equal(result.metrics?.actions,2);assert.deepEqual(result.trace.map(t=>t.targetKind),['button','textbox']);
});

test('overall deadline interrupts observation and is distinct from explicit cancellation',async()=>{
  const f=fixture([]),c=new RunController();
  const run=c.start('owner','profile','s','typesafe-jev','Read the paragraph.',async(command,input)=>command==='v2.frames'?new Promise(()=>{}):f.call(command,input),{...options,timeoutMs:25});
  const result=await terminal(c,run.id);assert.equal(result.status,'failed');assert.equal(result.code,'run_timeout');assert.equal(result.phase,'terminal');assert.equal(result.metrics?.decisions,0);
});

test('long literal and option continuation are verified from exact readers rather than truncated previews',async()=>{
 const value='Authorized text '.repeat(180),field=control('f','textbox','Comment',{value:''}),f=fixture([field]);let actual='';
 f.hooks.decision=async()=>({status:'selected',choiceId:'op_0',latencyMs:0});f.hooks.read=async()=>({text:actual,complete:true,truncated:false,nextOffset:null,provenance:{documentToken:'token'}});
 f.hooks.commit=async()=>{assert(f.action?.type==='fill');actual=f.action.value;field.value=actual.slice(0,2000);return {action:{dispatch:'sent',outcome:'verified'}};};
 const c=new RunController(),run=c.start('owner','profile','s','typesafe-jev',`Fill Comment with "${value}".`,f.call,{...options,maxSteps:1});const longResult=await terminal(c,run.id);assert.equal(longResult.status,'completed',JSON.stringify(longResult));assert.equal(actual,value);
 const all=Array.from({length:80},(_,index)=>({index,label:'Colour '+index,disabled:false,selected:false})),select=control('s','combobox','Colour',{optionCount:80,options:all.slice(0,40)}),g=fixture([select]);
 g.hooks.read=async()=>({options:all.map(o=>({...o})),complete:true,truncated:false,nextOffset:null,provenance:{documentToken:'token'}});g.hooks.decision=f.hooks.decision;
 g.hooks.commit=async()=>{assert(g.action?.type==='select');assert.deepEqual(g.action.indices,[75]);all[75].selected=true;select.options=all.slice(0,40);return {action:{dispatch:'sent',outcome:'verified'}};};
 const run2=c.start('owner','profile','s2','typesafe-jev','Select Colour 75 in the dropdown.',g.call,{...options,maxSteps:1});const optionResult=await terminal(c,run2.id);assert.equal(optionResult.status,'completed',JSON.stringify(optionResult));assert(all[75].selected);
});
