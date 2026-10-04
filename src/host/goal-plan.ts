import {PilotError,type Snapshot} from '../shared.js';
import type {BrowserAction,TargetV2,ObservationV2} from '../capabilities.js';
import {answerFacts,listAnswerFacts,relevantFacts,type Fact} from './evidence-facts.js';

export type ObservedFrame={frameId:number;state:{stateVersion:string;binding:{tabId?:number;documentId:string;origin:string};humanProgress?:{status:string;reason:string};snapshot:ObservationV2}};
export type GoalOperation={description:string;frameId:number;stateVersion:string;snapshot:ObservationV2;action?:BrowserAction;read?:{targetId:string;format:string;offset:number;limit:number}};
type Obligation={name:string;count:number;done:number};
const number=(value:string)=>({one:1,two:2,three:3}[value.toLowerCase()]??Number(value));
const clean=(value:string)=>value.trim().replace(/^["“']|["”']$/g,'');

/** Bounded public-goal grammar. Page strings only ground targets, never grant intent. */
export class GoalPlan{
  readonly mode:'retrieval'|'check'|'select'|'fill'|'sequence';
  private checked=true;
  private option?:string;
  private value?:string;
  private obligations:Obligation[]=[];
  private expectedText?:string;
  private expectedCount?:{name:string;count:number};
  private absentKind?:string;
  private absenceConfirmation=false;
  private receiptBaseline?:{frameId:number;documentToken:string;lines:Set<string>};
  private boundControls?:{frameId:number;documentToken:string;id:string}[];
  constructor(readonly goal:string){
    if(/^(?:return|read|get|find|list|what|how many|(?:top|first|last)\s+\d+)\b/i.test(goal.trim())){this.mode='retrieval';return;}
    if(/^(?:uncheck|check)\b/i.test(goal)&&/\bcheckbox(?:es)?\b/i.test(goal)){
      if(!/\b(?:both|all|every)\b/i.test(goal))throw new PilotError('unsupported_intent');
      this.mode='check';this.checked=!/^uncheck\b/i.test(goal);return;
    }
    const option=goal.match(/^select\s+(.+?)\s+(?:in|from)\s+(?:the\s+)?(?:dropdown|select|listbox)\b/i);
    if(option){this.mode='select';this.option=clean(option[1]);return;}
    const literals=[...goal.matchAll(/"([^"\n]{1,16000})"|“([^”\n]{1,16000})”/gu)].map(m=>m[1]??m[2]);
    if(/\b(?:enter|fill|replace)\b/i.test(goal)&&literals.length===1){this.mode='fill';this.value=literals[0];return;}
    if(!/^click\b/i.test(goal))throw new PilotError('unsupported_intent');
    this.mode='sequence';
    for(const clause of goal.split(/\bthen\b|,\s*then\b|\.\s*Finish\b/i)){
      const click=clause.match(/\bclick\s+(.+?)(?=\s+(?:twice|once|\d+ times|in\b|and\b)|[,.]|$)/i);
      const remove=clause.match(/^\s*(?:,\s*)?delete\s+(?:one|1)\b/i);
      if(click){const repetition=clause.match(/\b(twice|once|\d+ times)\b/i)?.[1]??'once';const count=repetition.toLowerCase()==='twice'?2:repetition.toLowerCase()==='once'?1:parseInt(repetition);if(count>10)throw new PilotError('unsupported_intent');this.obligations.push({name:clean(click[1]),count,done:0});}
      else if(remove)this.obligations.push({name:'Delete',count:1,done:0});
    }
    const text=goal.match(/until\s+["“]?(.+?)["”]?\s+becomes?\s+visible/i);
    if(text)this.expectedText=clean(text[1]);
    const confirmation=goal.match(/(?:confirms?|shows?|contains?)\s+["“]([^"”]+)["”]/i);
    if(/\bcheckbox\s+disappears\b/i.test(goal))this.absentKind='checkbox';
    if(confirmation)this.expectedText=confirmation[1];
    else if(/\bconfirms?\b/i.test(goal)){
      if(this.absentKind&&/\bconfirms?\s+(?:that\s+)?(?:it|the checkbox)\s+(?:is gone|has (?:disappeared|been removed|been deleted))\b/i.test(goal))this.absenceConfirmation=true;
      else throw new PilotError('unsupported_intent');
    }
    const count=goal.match(/exactly\s+(one|two|three|\d+)\s+(.+?)\s+buttons?\s+remaining/i);
    if(count)this.expectedCount={count:number(count[1]),name:clean(count[2])};
    if(!this.obligations.length||(!this.expectedText&&!this.expectedCount&&!this.absentKind))throw new PilotError('unsupported_intent');
  }
  get retrieval(){return this.mode==='retrieval';}
  retrievalTargets(frame:ObservedFrame){
    const ordinal=this.goal.match(/\b(?:the\s+)?(first|second|third|\d+(?:st|nd|rd|th)?)\s+shadow\s+root\b/i);
    if(ordinal){
      if(!/\bparagraph\b/i.test(this.goal))throw new PilotError('unsupported_retrieval_scope');
      const index=({first:1,second:2,third:3}[ordinal[1].toLowerCase()]??parseInt(ordinal[1]));
      return frame.state.snapshot.targets.filter(t=>t.visible&&!t.secret&&t.kind==='paragraph'&&t.shadowRootPath?.at(-1)===index);
    }
    return frame.state.snapshot.targets.filter(t=>t.visible&&!t.secret&&(['table','grid','article','main','region'].includes(t.kind)||t.name==='Page body')).slice(0,12);
  }
  progress(){return {mode:this.mode,obligations:this.obligations.map(o=>({...o})),terminal:{text:this.expectedText,count:this.expectedCount,absent:this.absentKind}};}
  private controls(frames:ObservedFrame[],kinds:string[]){
    return frames.flatMap(frame=>frame.state.snapshot.targets.filter(t=>t.visible&&!t.secret&&kinds.includes(t.kind)).map(target=>({frame,target})));
  }
  readRequirements(frames:ObservedFrame[]){
    const controls=this.mode==='select'?this.controls(frames,['combobox','listbox']).filter(({target})=>(target.optionCount??0)>40):this.mode==='fill'&&(this.value?.length??0)>2000?this.editable(frames):[];
    if(controls.length>12)throw new PilotError('observation_scope_limit');
    return controls.map(({frame,target})=>({frameId:frame.frameId,target,format:this.mode==='select'?'options':'text'}));
  }
  evaluate(frames:ObservedFrame[]){
    if(frames.some(f=>f.state.snapshot.coverage.truncated))return false;
    if(this.mode==='retrieval')return false;
    if(this.mode==='check'){
      const controls=this.controls(frames,['checkbox']);
      if(/\bboth\b/i.test(this.goal)&&controls.length!==2)return false;
      if(!this.boundControls){if(!controls.length)return false;this.boundControls=controls.map(({frame,target})=>({frameId:frame.frameId,documentToken:frame.state.snapshot.provenance.documentToken,id:target.id}));}
      for(const {frame,target} of controls)if(!this.boundControls.some(bound=>bound.frameId===frame.frameId&&bound.id===target.id))this.boundControls.push({frameId:frame.frameId,documentToken:frame.state.snapshot.provenance.documentToken,id:target.id});
      return this.boundControls.every(bound=>controls.some(({frame,target})=>frame.frameId===bound.frameId&&frame.state.snapshot.provenance.documentToken===bound.documentToken&&target.id===bound.id&&target.checked===this.checked));
    }
    if(this.mode==='select'){
      const controls=this.controls(frames,['combobox','listbox']).filter(({target})=>target.options?.some(o=>o.label===this.option));
      if(controls.length>1)throw new PilotError('ambiguous_target');
      return controls.length===1&&controls[0].target.options!.some(o=>o.label===this.option&&o.selected);
    }
    if(this.mode==='fill'){
      const controls=this.editable(frames);return controls.length===1&&!controls[0].target.disabled&&!controls[0].target.readonly&&controls[0].target.value===this.value;
    }
    if(this.obligations.some(o=>o.done<o.count))return false;
    if(this.expectedText)return false;
    if(this.expectedCount)return this.controls(frames,['button']).filter(({target})=>target.name===this.expectedCount!.name).length===this.expectedCount.count;
    if(this.absentKind)return !this.absenceConfirmation&&!this.controls(frames,[this.absentKind]).length;
    return false; // Text is verified through exact readers, not preview names.
  }
  pendingText(frames:ObservedFrame[]){
    if(this.mode!=='sequence'||this.obligations.some(o=>o.done<o.count)||frames.some(f=>f.state.snapshot.coverage.truncated))return undefined;
    if(this.absentKind&&this.controls(frames,[this.absentKind]).length)return undefined;
    if(this.expectedCount&&this.controls(frames,['button']).filter(({target})=>target.name===this.expectedCount!.name).length!==this.expectedCount.count)return undefined;
    return this.expectedText;
  }
  confirmationReads(frames:ObservedFrame[]){
    if(!this.absenceConfirmation)return [];
    const scope=this.receiptBaseline?frames.filter(f=>f.frameId===this.receiptBaseline!.frameId&&f.state.snapshot.provenance.documentToken===this.receiptBaseline!.documentToken):frames.filter(f=>f.state.snapshot.targets.some(t=>t.kind===this.absentKind&&t.visible));
    if(scope.length!==1||!this.receiptBaseline&&scope[0].state.snapshot.targets.filter(t=>t.kind===this.absentKind&&t.visible).length!==1)throw new PilotError('ambiguous_confirmation_scope');
    if(scope[0].state.snapshot.coverage.truncated)throw new PilotError('incomplete_observation');
    return scope.flatMap(frame=>frame.state.snapshot.targets.filter(t=>t.name==='Page body').map(target=>({frame,target})));
  }
  confirmAbsence(frame:ObservedFrame,text:string){
    const lines=text.split('\n').map(line=>line.trim()).filter(Boolean);
    if(!this.receiptBaseline){this.receiptBaseline={frameId:frame.frameId,documentToken:frame.state.snapshot.provenance.documentToken,lines:new Set(lines)};return;}
    if(this.obligations.some(o=>o.done<o.count)||frame.state.snapshot.targets.some(t=>t.kind===this.absentKind&&t.visible))return;
    // A fresh, standalone affirmative receipt is required alongside observed
    // absence. Old messages, negations and prose mentioning removal do not prove it.
    return lines.find(line=>!this.receiptBaseline!.lines.has(line)&&/^(?:(?:it(?:'s| is)|the checkbox is) gone|(?:it|the checkbox) (?:has (?:been )?)?(?:removed|deleted|disappeared)|(?:the )?checkbox (?:removed|deleted))(?: successfully)?[.!]?$/i.test(line));
  }
  private instruction(){return this.goal.replace(/"[^"\n]*"|“[^”\n]*”/gu,'').toLowerCase();}
  private editable(frames:ObservedFrame[]){
    const instruction=this.instruction();
    if(frames.some(frame=>frame.state.snapshot.targets.some(target=>target.secret&&target.name.length>2&&instruction.includes(target.name.toLowerCase()))))throw new PilotError('sensitive_field_requires_workflow');

    const controls=this.controls(frames,['textbox','combobox']).filter(({frame,target})=>(!instruction.includes('iframe')||frame.frameId!==0)&&!target.secret&&!['password','one-time-code'].includes(target.inputPurpose??''));
    const named=controls.filter(({target})=>target.name.length>2&&this.instruction().includes(target.name.toLowerCase()));
    const matches=named.length?named:controls;
    if(matches.length>1)throw new PilotError('ambiguous_target');return matches;
  }
  operations(frames:ObservedFrame[],readonly:boolean):GoalOperation[]{
    if(this.retrieval)return [];
    if(frames.some(frame=>frame.state.snapshot.coverage.truncated))throw new PilotError('incomplete_observation');
    if(readonly)throw new PilotError('readonly_mode');
    const operations:GoalOperation[]=[];
    const add=(frame:ObservedFrame,target:TargetV2,action:BrowserAction)=>operations.push({frameId:frame.frameId,stateVersion:frame.state.stateVersion,snapshot:frame.state.snapshot,description:`Task-authorized ${action.type}: ${target.name||target.kind}`,action});
    if(this.mode==='check')for(const {frame,target} of this.controls(frames,['checkbox'])){if(!target.disabled&&target.checked!==this.checked)add(frame,target,{type:'check',targetId:target.id,checked:this.checked});}
    if(this.mode==='select')for(const {frame,target} of this.controls(frames,['combobox','listbox'])){const options=target.options?.filter(o=>o.label===this.option&&!o.disabled);if(options?.length===1&&!options[0].selected&&!target.disabled)add(frame,target,{type:'select',targetId:target.id,indices:[options[0].index]});}
    if(this.mode==='fill'){
      for(const {frame,target} of this.editable(frames))if(!target.disabled&&!target.readonly&&target.value!==this.value)add(frame,target,target.inputType==='contenteditable'?{type:'replace',targetId:target.id,start:0,end:target.value?.length??0,text:this.value!}:{type:'fill',targetId:target.id,value:this.value!,backend:'dom'});
      if(!operations.length)for(const {frame,target} of this.controls(frames,['button']))if(!target.disabled&&target.name.length>2&&this.instruction().includes(target.name.toLowerCase()))add(frame,target,{type:'click',targetId:target.id,backend:'dom'});
    }
    if(this.mode==='sequence'){
      const next=this.obligations.find(o=>o.done<o.count);
      if(next){const matches=this.controls(frames,['button','link']).filter(({target})=>target.name===next.name&&!target.disabled);if(matches.length>1&&next.name!=='Delete')throw new PilotError('ambiguous_target');if(matches.length)add(matches[0].frame,matches[0].target,{type:'click',targetId:matches[0].target.id,backend:'dom'});}
    }
    return operations;
  }
  record(action:BrowserAction,target:TargetV2,dispatch:string|undefined,outcome:string|undefined){
    if(this.mode!=='sequence'||action.type!=='click')return;
    const next=this.obligations.find(o=>o.done<o.count);
    if(next&&target.name===next.name&&dispatch==='sent'&&outcome!=='failed'&&outcome!=='unknown')next.done++;
  }
}

/** Projection is data-only; canonical execution never consumes legacy snapshots. */
export function readerFacts(goal:string,frame:ObservedFrame,reads:{target:TargetV2;result:any}[]):Fact[]{
  if(/\bshadow\s+root\b/i.test(goal))return reads.filter(({target,result})=>target.kind==='paragraph'&&target.shadowRootPath&&result.complete&&!result.truncated&&typeof result.text==='string').map(({target,result})=>({value:result.text.trim(),evidence:{origin:frame.state.snapshot.origin,path:frame.state.snapshot.path,documentId:frame.state.binding.documentId,documentToken:result.provenance.documentToken,targetId:target.id,description:`Exact paragraph text in observed shadow root ${target.shadowRootPath!.at(-1)}`,complete:true}}));
  const snapshot:Snapshot={documentToken:frame.state.snapshot.provenance.documentToken,origin:frame.state.snapshot.origin,path:frame.state.snapshot.path,title:frame.state.snapshot.title,targets:reads.filter(({result})=>result.rows).map(({target,result})=>({id:target.id,kind:'table',name:target.name,section:target.section,preview:result.rows,previewTruncated:!result.complete||!!result.truncated})),text:reads.map(({result})=>result.text??'').join('\n')};
  const binding={tabId:0,documentId:frame.state.binding.documentId,origin:snapshot.origin};
  const list=/\b(?:top|first|last)\s+\d+\b|\blist\b/i.test(goal);
  const facts=relevantFacts(goal,list?listAnswerFacts(goal,snapshot,binding):answerFacts(snapshot,binding));
  if(!list)for(const {target,result} of reads)if(result.complete&&!result.truncated&&typeof result.text==='string'){
    for(const line of result.text.split('\n').map((s:string)=>s.trim()).filter(Boolean).slice(0,80))if(line.length<=500)facts.push({value:line,evidence:{origin:snapshot.origin,path:snapshot.path,documentId:binding.documentId,documentToken:snapshot.documentToken,targetId:target.id,section:target.section,description:`${target.name}: observed text ${line}`.slice(0,240),complete:true}});
  }
  return facts;
}
