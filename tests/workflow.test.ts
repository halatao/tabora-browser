import test from 'node:test';import assert from 'node:assert/strict';
import {workflowChoices,executeWorkflow} from '../src/host/workflow.js';import type {ObservationV2} from '../src/capabilities.js';import type {RunStatus} from '../src/host/run-controller.js';
import {workflowSchema} from '../src/browser-api.js';
const target={id:'r1',name:'Customer',kind:'textbox',role:'textbox',visible:true,disabled:false,readonly:false,value:''};
const snapshot:ObservationV2={schemaVersion:2,snapshotId:'snapshot',epoch:1,origin:'https://test.local',path:'/',title:'test',targets:[target,{...target,id:'r2',name:'Save',kind:'button',role:'button'}],coverage:{scanned:2,targetCount:2,truncated:false,cursor:0,nextCursor:null},provenance:{source:'page',trust:'untrusted',documentToken:'token'}};
const workflow=workflowSchema.parse({values:[{field:'Customer',value:'Supplied'}],success:{name:'Receipt',contains:'Saved'},nativeInput:false});
test('workflow values are task-bound and readonly/secret controls never offer writes',()=>{const operations=workflowChoices(snapshot,workflow,false);assert(operations.some(op=>op.action?.type==='fill'&&op.action.value==='Supplied'));assert(!workflowChoices(snapshot,workflow,true).some(op=>op.action));assert(!workflowChoices({...snapshot,targets:[{...target,secret:true}]},workflow,false).some(op=>op.action));});
test('workflow does not confuse dispatch with success and carries actual provider diagnostics',async()=>{
  let step=0;const status:RunStatus={id:'run',sessionId:'session',provider:'typesafe-jev',status:'running',elapsedMs:0,steps:0,trace:[]};
  await executeWorkflow(status,'Save customer',workflow,false,5,async(command,input:any)=>{
    if(command==='v2.frames')return {frames:[{frameId:0,allowed:true}]};
    if(command==='v2.state')return {stateVersion:'document:snapshot',binding:{documentId:'document'},snapshot:step<2?snapshot:{...snapshot,targets:[{...target,id:'r3',name:'Receipt',kind:'region'}]}};
    if(command==='select'){assert.equal(input.request.context.page.provenance.trust,'untrusted');return {status:'selected',choiceId:'op_'+(step===0?0:1),latencyMs:12,model:'actual-model',runtime:{coldStart:step===0,setupMs:0,dispatchMs:12,cleanupMs:0}};}
    if(command==='v2.plan')return {actionId:'id',stateVersion:'document:snapshot'};
    if(command==='v2.commit'){step++;assert.equal(status.status,'running');return {action:{dispatch:'sent',outcome:'unverified'},readiness:{state:'observed'}};}
    if(command==='v2.read')return {text:'Saved record-123',complete:true};throw Error(command);
  },value=>value);
  assert.equal(status.status,'completed');assert.equal(status.answer,'Saved record-123');assert.equal(status.trace.length,2);
});
test('pending submit cannot be replayed while the server receipt is delayed',async()=>{
  let submits=0,observations=0;
  const status:RunStatus={id:'run',sessionId:'session',provider:'typesafe-jev',status:'running',elapsedMs:0,steps:0,trace:[]};
  const page={...snapshot,targets:[{...target,id:'save',kind:'button',name:'Save'},{...target,id:'receipt',kind:'status',name:'Receipt'}]};
  await executeWorkflow(status,'Save exactly once',{...workflow,values:[]},false,5,async(command,input:any)=>{
    if(command==='v2.frames')return {frames:[{frameId:0,allowed:true}]};
    if(command==='v2.state'){observations++;return {stateVersion:'document:snapshot',binding:{documentId:'document'},snapshot:page};}
    if(command==='v2.read')return {text:submits&&observations>=3?'Saved one-record':'Ready',complete:true};
    if(command==='select'){
      const submit=input.request.choices.find((choice:any)=>choice.description.startsWith('Activate button: Save'));
      return {status:'selected',choiceId:submit?.id??'inspect',latencyMs:1,model:'fixture'};
    }
    if(command==='v2.plan'){assert.equal(input.expect.contains,'Saved');return {actionId:'id',stateVersion:'document:snapshot'};}
    if(command==='v2.commit'){submits++;return {action:{dispatch:'sent',outcome:'unverified'},readiness:{state:'timeout'}};}
    throw Error(command);
  },value=>value);
  assert.equal(submits,1);assert.equal(status.status,'completed');
});
test('unknown write recovers from fresh receipt without another decision or write',async()=>{
  const status:RunStatus={id:'run',sessionId:'session',provider:'codex-sdk',status:'running',elapsedMs:0,steps:0,trace:[]};let observations=0,writes=0,decisions=0;
  const page={...snapshot,targets:[{...target,id:'save',kind:'button',name:'Save'},{...target,id:'receipt',kind:'status',name:'Receipt'}]};
  await executeWorkflow(status,'Save once',workflowSchema.parse({success:{name:'Receipt',contains:'Saved'}}),false,8,async(command,input:any)=>{
    if(command==='v2.frames')return {frames:[{frameId:0,allowed:true}]};
    if(command==='v2.state'){observations++;return {stateVersion:'document:snapshot',binding:{documentId:'document'},snapshot:page};}
    if(command==='v2.read')return {text:observations>=3?'Saved one record':'Ready',complete:true};
    if(command==='select'){decisions++;return {status:'selected',choiceId:input.request.choices.find((choice:any)=>choice.description.startsWith('Activate')).id,latencyMs:1,model:'fixture'};}
    if(command==='v2.plan')return {actionId:'id',stateVersion:'document:snapshot'};
    if(command==='v2.commit'){writes++;return {action:{dispatch:'unknown',outcome:'unknown'}};}
    throw Error(command);
  },value=>value);assert.equal(writes,1);assert.equal(decisions,1);assert.equal(status.status,'completed');
});
test('multiselect clearing, requested drag and trusted keyboard choices are explicit',()=>{
  const list={...target,id:'list',kind:'listbox',multiple:true,options:[{index:0,label:'First',selected:true,disabled:false}]};
  const flow=workflowSchema.parse({values:[{field:'Customer',value:[]}],drags:[{source:{name:'Record'},destination:{name:'Destination'}}],success:{name:'Receipt',contains:'Saved'},nativeInput:true});
  const operations=workflowChoices({...snapshot,targets:[list,{...target,id:'source',name:'Record',kind:'listitem'},{...target,id:'dest',name:'Destination',kind:'region'},{...target,id:'save',name:'Save',kind:'button'}]},flow,false);
  assert(operations.some(item=>item.action?.type==='select'&&item.action.indices.length===0));assert(operations.some(item=>item.action?.type==='drag'));assert(operations.some(item=>item.action?.type==='key'));assert(!workflowChoices(snapshot,flow,true).some(item=>item.action?.type==='drag'));
});
test('exact answer consumes all revision-bound chunks without a model call',async()=>{
  const status:RunStatus={id:'run',sessionId:'session',provider:'codex-sdk',status:'running',elapsedMs:0,steps:0,trace:[]},flow=workflowSchema.parse({answer:{name:'Customer',format:'text'}});let reads=0;
  await executeWorkflow(status,'Read Customer exactly',flow,true,5,async(command,input:any)=>{
    if(command==='v2.frames')return {frames:[{frameId:0,allowed:true}]};
    if(command==='v2.state')return {stateVersion:'document:snapshot',binding:{documentId:'document'},snapshot};
    if(command==='v2.read'){reads++;assert.equal(input.offset,reads===1?0:5);if(reads===2)assert.equal(input.revision,'revision');return {text:reads===1?'00012':'345678901234567890',revision:'revision',nextOffset:reads===1?5:null,complete:reads===2,truncated:reads===1,provenance:{documentToken:'token'}};}
    throw Error('Unexpected mutation or model: '+command);
  },value=>value);assert.equal(status.answer,'00012345678901234567890');assert.equal(status.trace.length,0);
});
test('long currency and ranking stay exact beyond Number precision',async()=>{
  const {answerFacts}=await import('../src/host/run-controller.js');const s:any={documentToken:'t',origin:'https://test.local',path:'/',targets:[{id:'table',kind:'table',name:'Amounts',preview:[['Record','Value'],['A','9007199254740992'],['B','9007199254740993']],previewTruncated:false}],text:'Total: $9,007,199,254,740,993.01'};
  const facts=answerFacts(s,{documentId:'d',tabId:1,origin:s.origin});assert(facts.some(f=>f.value==='B'&&f.evidence.description.includes('highest Value = 9007199254740993')));assert(facts.some(f=>f.value==='9007199254740993.01'));
});
test('unrelated page churn cannot make a pending submit available again',async()=>{
  let submits=0,observations=0;const status:RunStatus={id:'run',sessionId:'session',provider:'typesafe-jev',status:'running',elapsedMs:0,steps:0,trace:[]},flow=workflowSchema.parse({success:{name:'Receipt',contains:'Saved'}});
  await executeWorkflow(status,'Save once',flow,false,5,async(command,input:any)=>{
    if(command==='v2.frames')return {frames:[{frameId:0,allowed:true}]};
    if(command==='v2.state'){observations++;return {stateVersion:'document:snapshot',binding:{documentId:'document'},snapshot:{...snapshot,dataVersion:String(observations),targets:[{...target,id:'save',kind:'button',name:'Save'},{...target,id:'receipt',kind:'status',name:'Receipt'}]}};}
    if(command==='v2.read')return {text:submits&&observations>=3?'Saved once':'Ready',complete:true};
    if(command==='select')return {status:'selected',choiceId:input.request.choices.find((choice:any)=>choice.description.startsWith('Activate'))?.id??'inspect',latencyMs:1,model:'fixture'};
    if(command==='v2.plan')return {actionId:'id',stateVersion:'document:snapshot'};
    if(command==='v2.commit'){submits++;return {action:{dispatch:'sent',outcome:'unverified'},readiness:{state:'timeout'}};}
    throw Error(command);
  },value=>value);assert.equal(submits,1);assert.equal(status.status,'completed');
});
test('mouse activation cannot be replayed with Enter after a lost acknowledgement',async()=>{
  let submits=0,checked=false;const status:RunStatus={id:'run',sessionId:'session',provider:'typesafe-jev',status:'running',elapsedMs:0,steps:0,trace:[]},flow=workflowSchema.parse({success:{name:'Receipt',contains:'Saved'},nativeInput:true});
  const page={...snapshot,targets:[{...target,id:'save',kind:'button',name:'Save'},{...target,id:'check',kind:'button',name:'Check receipt'},{...target,id:'receipt',kind:'status',name:'Receipt'}]};
  await executeWorkflow(status,'Save once; inspect Check receipt if acknowledgement is lost',flow,false,6,async(command,input:any)=>{
    if(command==='v2.frames')return {frames:[{frameId:0,allowed:true}]};
    if(command==='v2.state')return {stateVersion:'document:snapshot',binding:{documentId:'document'},snapshot:page};
    if(command==='v2.read')return {text:checked?'Saved one record':'Ready',complete:true};
    if(command==='select'){const choices=input.request.choices;if(submits){assert(!choices.some((choice:any)=>choice.description.startsWith('Activate button: Save')||choice.description.includes('Save and press Enter')));return {status:'selected',choiceId:choices.find((choice:any)=>choice.description.startsWith('Activate button: Check receipt')).id,latencyMs:1,model:'fixture'};}return {status:'selected',choiceId:choices.find((choice:any)=>choice.description.startsWith('Activate button: Save')).id,latencyMs:1,model:'fixture'};}
    if(command==='v2.plan')return {actionId:input.action.targetId,stateVersion:'document:snapshot'};
    if(command==='v2.commit'){if(input.actionId==='save')submits++;else checked=true;return {action:{dispatch:'sent',outcome:'unverified'},readiness:{state:'timeout'}};}throw Error(command);
  },value=>value);assert.equal(submits,1);assert.equal(status.status,'completed');
});

test('collection sums exact decimals once per stable key and completes its export',async()=>{
  const status:RunStatus={id:'r',sessionId:'s',provider:'codex-sdk',status:'running',elapsedMs:0,steps:0,trace:[]};let page=0,downloads=0;
  const flow=workflowSchema.parse({answer:{name:'Amounts',format:'aggregate',column:1,operation:'sum',decimal:'.',group:'',collection:{next:'Next',keyColumn:0,maxPages:3}},downloads:[{link:'Export',name:'amounts.csv'}]});
  const pages=[[['ID','Amount'],['a','9007199254740993.01'],['b','0.09']],[['ID','Amount'],['b','0.09'],['c','1.90']]];
  await executeWorkflow(status,'Sum and export',flow,false,5,async(command,input:any)=>{
    if(command==='v2.frames')return {frames:[{frameId:0,allowed:true}]};
    if(command==='v2.state')return {stateVersion:'d:s',binding:{documentId:'d'},snapshot:{...snapshot,targets:[{...target,id:'table',kind:'table',name:'Amounts'},{...target,id:'next',kind:'button',name:'Next',disabled:page===1},{...target,id:'export',kind:'link',name:'Export'}]}};
    if(command==='v2.read'){assert.equal(input.format,'rows');return {rows:pages[page],headerRows:1,complete:true,truncated:false,nextOffset:null,revision:'p'+page,provenance:{documentToken:'token'}};}
    if(command==='v2.plan')return {actionId:'next',stateVersion:'d:s'};
    if(command==='v2.commit'){page++;return {action:{dispatch:'sent',outcome:'unverified'}};}
    if(command==='workflow.download'){downloads++;return {state:'complete',artifact:{id:'export',name:input.name}};}
    throw Error(command);
  },value=>value);
  assert.equal(status.answer,'9007199254740995.00');assert.equal(downloads,1);assert.equal(status.artifacts?.length,1);assert.equal(status.trace.length,0);
});

test('long supplied text is reconciled exactly instead of refilling a truncated preview',async()=>{
  const value='x'.repeat(3000),status:RunStatus={id:'r',sessionId:'s',provider:'codex-sdk',status:'running',elapsedMs:0,steps:0,trace:[]};let saved=false;
  const flow=workflowSchema.parse({values:[{field:'Customer',value}],success:{name:'Receipt',contains:'Saved'}});
  await executeWorkflow(status,'Save long Customer once',flow,false,4,async(command,input:any)=>{
    if(command==='v2.frames')return {frames:[{frameId:0,allowed:true}]};
    if(command==='v2.state')return {stateVersion:'d:s',binding:{documentId:'d'},snapshot:{...snapshot,targets:[{...target,value:value.slice(0,2000)},{...target,id:'save',kind:'button',name:'Save'},{...target,id:'receipt',name:'Receipt',kind:'status'}]}};
    if(command==='v2.read')return {text:input.targetId==='r1'?value:saved?'Saved':'Ready',complete:true,truncated:false,nextOffset:null,revision:'r',provenance:{documentToken:'token'}};
    if(command==='select'){assert(!input.request.choices.some((choice:any)=>choice.description.startsWith('Set Customer')));return {status:'selected',choiceId:input.request.choices.find((choice:any)=>choice.description==='Activate button: Save [frame 0]').id,model:'test',latencyMs:1};}
    if(command==='v2.plan'){assert.equal(input.action.type,'click');return {actionId:'a',stateVersion:'d:s'};}
    if(command==='v2.commit'){saved=true;return {action:{dispatch:'sent',outcome:'unverified'}};}throw Error(command);
  },value=>value);assert.equal(status.status,'completed');
});

test('PDF-derived fill and attachment reuse one immutable download',async()=>{
  const document={link:'Invoice',name:'invoice.pdf',format:'pdf' as const,page:2,extract:{prefix:'Reference: '}},status:RunStatus={id:'r',sessionId:'s',provider:'codex-sdk',status:'running',elapsedMs:0,steps:0,trace:[]};let downloads=0,uploaded=false,filled=false,saved=false;
  const flow=workflowSchema.parse({derivedValues:[{field:'Customer',source:document}],attachments:[{field:'Invoice attachment',document}],success:{name:'Receipt',contains:'Saved'}});
  await executeWorkflow(status,'Copy Invoice reference to Customer, attach Invoice and Save',flow,false,6,async(command,input:any)=>{
    if(command==='v2.frames')return {frames:[{frameId:0,allowed:true}]};
    if(command==='v2.state')return {stateVersion:'d:s',binding:{documentId:'d'},snapshot:{...snapshot,targets:[{...target,value:filled?'000123':''},{...target,id:'file',name:'Invoice attachment',kind:'file'},{...target,id:'invoice',name:'Invoice',kind:'link'},{...target,id:'save',name:'Save',kind:'button'},{...target,id:'receipt',name:'Receipt',kind:'status'}]}};
    if(command==='v2.read')return {text:saved?'Saved':'Ready',complete:true};
    if(command==='workflow.download'){downloads++;return {state:'complete',artifact:{id:'artifact'}};}
    if(command==='workflow.document')return {text:'Reference: 000123',complete:true,truncated:false,nextOffset:null,revision:'r'};
    if(command==='select')return {status:'selected',choiceId:!filled?input.request.choices.find((choice:any)=>choice.description.startsWith('Set Customer')).id:!uploaded?'upload_0':input.request.choices.find((choice:any)=>choice.description.startsWith('Activate button: Save')).id,model:'test',latencyMs:1};
    if(command==='v2.plan')return {actionId:input.action.type,stateVersion:'d:s'};
    if(command==='v2.commit'){if(input.actionId==='fill')filled=true;else saved=true;return {action:{dispatch:'sent',outcome:'unverified'}};}
    if(command==='workflow.upload'){assert.deepEqual(input.artifactIds,['artifact']);uploaded=true;return {dispatch:'sent'};}throw Error(command);
  },value=>value);assert.equal(downloads,1);assert(uploaded&&filled&&saved);
});

test('experimental site operation is single-use after an uncertain dispatch',async()=>{
  const status:RunStatus={id:'r',sessionId:'s',provider:'codex-sdk',status:'running',elapsedMs:0,steps:0,trace:[]};let calls=0;
  const flow=workflowSchema.parse({siteOperations:[{name:'save',arguments:{value:'supplied'}}],success:{name:'Receipt',contains:'Saved'}});
  await assert.rejects(executeWorkflow(status,'Use save',flow,false,4,async(command,input:any)=>{
    if(command==='v2.frames')return {frames:[{frameId:0,allowed:true}]};
    if(command==='v2.state')return {stateVersion:'d:s',binding:{documentId:'d'},snapshot};
    if(command==='v2.site_tools')return {status:'experimental',documentId:'d',tools:[{name:'save',ref:'ref'}]};
    if(command==='select')return {status:'selected',choiceId:'site_0',model:'test',latencyMs:1};
    if(command==='v2.site_call'){calls++;assert.equal(input.toolRef,'ref');return {dispatch:'unknown'};}throw Error(command);
  },value=>value),/action_outcome_unknown/);assert.equal(calls,1);
});

test('scoped filename sources are imported once and never sent as filesystem commands to a provider',async()=>{
  const flow=workflowSchema.parse({attachments:[{field:'Contract',files:[{name:'contract.txt'}]}],success:{name:'Receipt',contains:'Saved'}}),status:RunStatus={id:'r',sessionId:'s',provider:'codex-sdk',status:'running',elapsedMs:0,steps:0,trace:[]};let imports=0,uploaded=false,saved=false;
  await executeWorkflow(status,'Attach contract.txt and Save once',flow,false,5,async(command,input:any)=>{
    if(command==='v2.frames')return {frames:[{frameId:0,allowed:true}]};
    if(command==='v2.state')return {stateVersion:'d:s',binding:{documentId:'d'},snapshot:{...snapshot,targets:[{...target,id:'file',kind:'file',name:'Contract'},{...target,id:'save',kind:'button',name:'Save'},{...target,id:'receipt',kind:'status',name:'Receipt'}]}};
    if(command==='v2.read')return {text:saved?'Saved':'Ready',complete:true};
    if(command==='workflow.file'){imports++;assert.deepEqual(input,{name:'contract.txt'});return {id:'artifact',name:'contract.txt'};}
    if(command==='select'){const choice=!uploaded?input.request.choices.find((choice:any)=>choice.id==='upload_0'):input.request.choices.find((choice:any)=>choice.description.startsWith('Activate button: Save'));assert(choice);assert(!JSON.stringify(input.request).includes('rootId'));return {status:'selected',choiceId:choice.id,model:'fixture',latencyMs:0};}
    if(command==='workflow.upload'){assert.deepEqual(input.artifactIds,['artifact']);uploaded=true;return {dispatch:'sent'};}
    if(command==='v2.plan')return {actionId:'save',stateVersion:'d:s'};
    if(command==='v2.commit'){saved=true;return {action:{dispatch:'sent',outcome:'unverified'}};}throw Error(command);
  },value=>value);assert.equal(imports,1);assert.equal(status.status,'completed');
});

test('a stalled scroll yields to an available action instead of repeating the same viewport',async()=>{
  const flow=workflowSchema.parse({success:{name:'Receipt',contains:'Saved'}}),status:RunStatus={id:'r',sessionId:'s',provider:'typesafe-jev',status:'running',elapsedMs:0,steps:0,trace:[]};
  const feed={...target,id:'feed',name:'Feed',kind:'region',scrollable:true,scroll:{x:0,y:800,viewportWidth:500,viewportHeight:120,maxX:0,maxY:800}};
  let decisions=0,saved=false,scrolls=0;
  await executeWorkflow(status,'Scroll Feed and save',flow,false,5,async(command,input:any)=>{
    if(command==='v2.frames')return {frames:[{frameId:0,allowed:true}]};
    if(command==='v2.state')return {stateVersion:'d:s',binding:{documentId:'d'},snapshot:{...snapshot,dataVersion:'loaded',targets:[feed,{...target,id:'save',kind:'button',name:'Save'},{...target,id:'receipt',kind:'status',name:'Receipt'}]}};
    if(command==='v2.read')return {text:saved?'Saved':'Ready',complete:true};
    if(command==='select'){
      decisions++;const choices=input.request.choices;
      if(decisions>1)assert(!choices.some((choice:any)=>choice.description.startsWith('Scroll Feed')));
      return {status:'selected',choiceId:choices.find((choice:any)=>choice.description.startsWith(decisions===1?'Scroll Feed':'Activate button: Save')).id,model:'test',latencyMs:0};
    }
    if(command==='v2.plan')return {actionId:input.action.type,stateVersion:'d:s'};
    if(command==='v2.commit'){if(input.actionId==='scroll'){scrolls++;return {action:{dispatch:'sent',outcome:'verified',progress:false}};}saved=true;return {action:{dispatch:'sent',outcome:'unverified'}};}
    throw Error(command);
  },value=>value);
  assert.equal(scrolls,1);assert.equal(status.status,'completed');
});

test('scrolling through repeated positions does not erase loop history',async()=>{
  const flow=workflowSchema.parse({success:{name:'Receipt',contains:'Saved'}}),status:RunStatus={id:'r',sessionId:'s',provider:'typesafe-jev',status:'running',elapsedMs:0,steps:0,trace:[]};let scrolls=0;
  await assert.rejects(executeWorkflow(status,'Find a new record by scrolling',flow,false,10,async(command,input:any)=>{
    if(command==='v2.frames')return {frames:[{frameId:0,allowed:true}]};
    if(command==='v2.state')return {stateVersion:'d:s',binding:{documentId:'d'},snapshot:{...snapshot,dataVersion:'same-record',targets:[{...target,id:'feed',kind:'region',name:'Feed',scrollable:true,scroll:{x:0,y:scrolls%2*200,viewportWidth:500,viewportHeight:120,maxX:0,maxY:800}}]}};
    if(command==='select')return {status:'selected',choiceId:input.request.choices.find((choice:any)=>choice.description.startsWith('Scroll Feed')).id,model:'test',latencyMs:0};
    if(command==='v2.plan')return {actionId:'scroll',stateVersion:'d:s'};
    if(command==='v2.commit'){scrolls++;return {action:{dispatch:'sent',outcome:'verified',progress:true}};}
    throw Error(command);
  },value=>value),/no_progress/);
  assert.equal(scrolls,4);
});

test('text-range edits refuse ambiguous occurrences before dispatch',()=>{
  const flow=workflowSchema.parse({edits:[{field:'Customer',from:'same',text:'changed'}],success:{name:'Receipt',contains:'Saved'}});
  assert.throws(()=>workflowChoices({...snapshot,targets:[{...target,inputType:'contenteditable',value:'same and same'}]},flow,false),/ambiguous_text_range/);
  assert(!workflowChoices({...snapshot,targets:[{...target,inputType:'contenteditable',value:'same'}]},flow,true).some(operation=>operation.action));
});


test('workflow vault login uses an opaque credential once and never submits or exports its bytes',async()=>{
  const credentialId='00000000-0000-4000-8000-000000000001';
  const flow=workflowSchema.parse({logins:[{credentialId,origin:snapshot.origin,form:'Account'}],success:{name:'Receipt',contains:'Saved'}});
  const status:RunStatus={id:'r',sessionId:'s',provider:'typesafe-jev',status:'running',elapsedMs:0,steps:0,trace:[]};let fills=0,saved=false;
  await executeWorkflow(status,'x'.repeat(1500),flow,false,5,async(command,input:any)=>{
    if(command==='vault.list')return [{id:credentialId,kind:'website',origin:snapshot.origin}];
    if(command==='v2.frames')return {frames:[{frameId:0,allowed:true}]};
    if(command==='v2.state')return {stateVersion:'d:s',binding:{documentId:'d',origin:snapshot.origin},snapshot:{...snapshot,targets:[{...target,inputType:'password',secret:true},{...target,id:'save',kind:'button',name:'Save'},{...target,id:'receipt',kind:'status',name:'Receipt'}]}};
    if(command==='v2.read')return {text:saved?'Saved':'Ready',complete:true};
    if(command==='select'){assert(!JSON.stringify(input).includes(credentialId));assert(input.request.question.length<=2000);assert.equal(input.request.context.taskProgress.originalGoal,'x'.repeat(1500));const choices=input.request.choices;if(fills){assert(!choices.some((choice:any)=>choice.id.startsWith('login_')));assert.equal(input.request.context.taskProgress.scopedCredentialFills,1);assert(input.request.question.includes('Hidden password bytes are not missing task parameters'));}return {status:'selected',choiceId:fills?choices.find((choice:any)=>choice.description.startsWith('Activate button: Save')).id:'login_0',model:'test',latencyMs:0};}
    if(command==='observe')return {binding:{origin:snapshot.origin,documentId:'d'},snapshot:{origin:snapshot.origin,documentToken:'legacy',targets:[{id:'f',kind:'form',name:'Account'}]}};
    if(command==='manual'){assert.equal(input.credentialId,credentialId);assert.equal(input.recipe,'login');return {actionId:'p'};}
    if(command==='step'){fills++;assert.equal(input.stateVersion,'d:legacy');return {action:{ok:true,verified:true,submitted:false}};}
    if(command==='v2.plan')return {actionId:'save',stateVersion:'d:s'};
    if(command==='v2.commit'){saved=true;return {action:{dispatch:'sent',outcome:'unverified'}};}
    throw Error(command);
  },value=>value);assert.equal(fills,1);assert.equal(status.status,'completed');
});

test('workflow validates scoped credential metadata before any model call or browser action',async()=>{
  const credentialId='00000000-0000-4000-8000-000000000001',flow=workflowSchema.parse({logins:[{credentialId,origin:snapshot.origin}],success:{name:'Receipt',contains:'Saved'}});
  for(const metadata of [[],[{id:credentialId,kind:'website',origin:'https://foreign.local'}],[{id:credentialId,kind:'provider',origin:snapshot.origin}]]){
    const status:RunStatus={id:'r',sessionId:'s',provider:'typesafe-jev',status:'running',elapsedMs:0,steps:0,trace:[]};
    await assert.rejects(executeWorkflow(status,'Sign in',flow,false,4,async(command)=>{assert.equal(command,'vault.list');return metadata;},value=>value),/credential_scope_mismatch/);assert.equal(status.trace.length,0);
  }
});

test('MFA is handed to the human before any decision or input',async()=>{
  const flow=workflowSchema.parse({values:[{field:'MFA',value:'123456'}],success:{name:'Receipt',contains:'Saved'}});
  const status:RunStatus={id:'r',sessionId:'s',provider:'typesafe-jev',status:'running',elapsedMs:0,steps:0,trace:[]};let handed=false;
  await executeWorkflow(status,'Continue',flow,false,3,async(command,input:any)=>{
    if(command==='v2.frames')return {frames:[{frameId:0,allowed:true}]};
    if(command==='v2.state')return {stateVersion:'d:s',binding:{documentId:'d'},snapshot:{...snapshot,targets:[{...target,name:'MFA',inputPurpose:'one-time-code',secret:true}]}};
    if(command==='v2.handoff'){assert.equal(input.reason,'mfa');handed=true;return {};}
    throw Error('Unexpected operation '+command);
  },value=>value);assert(handed);assert.equal(status.status,'needs_input');assert.equal(status.code,'mfa_required');
});

test('human resume reaches decision instructions without claiming authentication or exceeding the goal boundary',async()=>{
  const flow=workflowSchema.parse({success:{name:'Receipt',contains:'Saved'}}),status:RunStatus={id:'r',sessionId:'s',provider:'typesafe-jev',status:'running',elapsedMs:0,steps:0,trace:[]};let requested=false;
  await executeWorkflow(status,'x'.repeat(1500),flow,false,1,async(command,input:any)=>{
    if(command==='v2.frames')return {frames:[{frameId:0,allowed:true}]};
    if(command==='v2.state')return {stateVersion:'d:s',binding:{documentId:'d'},humanProgress:{status:'control_returned',reason:'mfa'},snapshot};
    if(command==='select'){requested=true;assert(input.request.question.startsWith('Human returned control.'));assert(input.request.question.includes('resume is not authentication proof'));assert.equal(input.request.context.taskProgress.humanProgress.status,'control_returned');assert.equal(input.request.context.taskProgress.originalGoal,'x'.repeat(1500));assert.deepEqual(input.request.context.taskProgress.terminal,{name:'Receipt',contains:'Saved'});assert(input.request.question.length<=2000);return {status:'selected',choiceId:'handoff',model:'test',latencyMs:0};}
    if(command==='v2.handoff')return {};
    throw Error(command);
  },value=>value);assert(requested);
});

test('native human dialog stops the workflow before another observation or dispatch',async()=>{
  for(const response of [{action:{dispatch:'unknown',outcome:'unknown',code:'needs_user'}},{action:{dispatch:'sent',outcome:'unknown'},readiness:{state:'needs_user'}}]){
    const status:RunStatus={id:'r',sessionId:'s',provider:'typesafe-jev',status:'running',elapsedMs:0,steps:0,trace:[]};let committed=false;
    await executeWorkflow(status,'Start Save and let the human answer the prompt',workflowSchema.parse({success:{name:'Receipt',contains:'Saved'}}),false,3,async(command,input:any)=>{
      assert(!committed,'No read, model call or dispatch after handoff');
      if(command==='v2.frames')return {frames:[{frameId:0,allowed:true}]};
      if(command==='v2.state')return {stateVersion:'d:s',binding:{documentId:'d'},snapshot};
      if(command==='select')return {status:'selected',choiceId:input.request.choices.find((choice:any)=>choice.description==='Activate button: Save [frame 0]').id,model:'test',latencyMs:0};
      if(command==='v2.plan')return {actionId:'p',stateVersion:'d:s'};
      if(command==='v2.commit'){committed=true;return response;}
      throw Error(command);
    },value=>value);assert(committed);assert.equal(status.status,'needs_input');assert.equal(status.code,'needs_user');assert.equal(status.trace[0].code,'needs_user');
  }
});

test('scope-blocked navigation stops without replay or another read',async()=>{
  const flow=workflowSchema.parse({success:{name:'Receipt',contains:'Saved'}}),status:RunStatus={id:'r',sessionId:'s',provider:'typesafe-jev',status:'running',elapsedMs:0,steps:0,trace:[]};let commits=0;
  await assert.rejects(executeWorkflow(status,'Save',flow,false,3,async(command,input:any)=>{
    if(command==='v2.frames')return {frames:[{frameId:0,allowed:true}]};
    if(command==='v2.state')return {stateVersion:'d:s',binding:{documentId:'d'},snapshot};
    if(command==='select')return {status:'selected',choiceId:input.request.choices.find((choice:any)=>choice.description==='Activate button: Save [frame 0]').id,model:'test',latencyMs:0};
    if(command==='v2.plan')return {actionId:'p',stateVersion:'d:s'};
    if(command==='v2.commit'){commits++;return {action:{dispatch:'sent'},readiness:{state:'scope_blocked'},code:'navigation_out_of_scope'};}
    throw Error(command);
  },value=>value),/navigation_out_of_scope/);assert.equal(commits,1);
});

test('exhausted choices hand off without an invalid one-choice decision request',async()=>{
  const flow=workflowSchema.parse({success:{name:'Receipt',contains:'Saved'}}),status:RunStatus={id:'r',sessionId:'s',provider:'typesafe-jev',status:'running',elapsedMs:0,steps:0,trace:[]};let decisions=0;
  await executeWorkflow(status,'Continue',flow,false,5,async(command)=>{
    if(command==='v2.frames')return {frames:[{frameId:0,allowed:true}]};
    if(command==='v2.state')return {stateVersion:'d:s',binding:{documentId:'d'},snapshot:{...snapshot,targets:[]}};
    if(command==='select'){decisions++;return {status:'selected',choiceId:'inspect',model:'test',latencyMs:0};}
    if(command==='v2.handoff')return {};
    throw Error(command);
  },value=>value);assert.equal(decisions,3);assert.equal(status.status,'needs_input');
});
