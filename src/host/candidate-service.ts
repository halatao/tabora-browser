import {PilotError} from '../shared.js';
import type {z} from 'zod';
import type {workflowSchema} from '../browser-api.js';
import type {BrowserAction,ObservationV2} from '../capabilities.js';
export function workflowChoices(snapshot:ObservationV2,workflow:z.infer<typeof workflowSchema>,readonly:boolean){
  const operations:{description:string;action?:BrowserAction;read?:{targetId:string;format:string;offset:number;limit:number;row?:number;column?:number;operation?:string;decimal?:string;group?:string}}[]=[];
  for(const target of snapshot.targets){
    if(!target.visible||target.disabled||target.secret)continue;
    if(['table','grid','article','main','region','generic','img'].includes(target.kind))operations.push({description:`Read exact ${target.kind}: ${target.name}`.slice(0,300),read:{targetId:target.id,format:['table','grid'].includes(target.kind)?'rows':target.kind==='img'?'chart':'text',offset:0,limit:8000}});
    if(target.scrollable)operations.push({description:`Scroll ${target.name||target.kind} forward by one bounded page`,action:{type:'scroll',targetId:target.id,y:Math.max(1,Math.min(600,Math.floor((target.scroll?.viewportHeight??750)*.8))),x:0}});
    if(readonly){if(target.kind==='link'&&target.href)operations.push({description:`Navigate browser to observed link ${target.name} without invoking its click handler`,action:{type:'navigate',targetId:target.id}});continue;}
    if(target.inputType==='contenteditable'&&!target.readonly&&target.value!==undefined){
      const edits=workflow.edits.filter(source=>source.field===target.name&&(!source.section||source.section===target.section)&&(!source.origin||source.origin===snapshot.origin));
      if(edits.length>1)throw new PilotError('ambiguous_workflow_field');
      if(edits.length){const edit=edits[0],start=target.value.indexOf(edit.from);if(start>=0){if(target.value.indexOf(edit.from,start+1)>=0)throw new PilotError('ambiguous_text_range');operations.push({description:`Replace only the task-specified text in ${target.name}`,action:{type:'replace',targetId:target.id,start,end:start+edit.from.length,text:edit.text}});}}
    }
    const sources=workflow.values.filter(source=>source.field===target.name&&(!source.section||source.section===target.section)&&(!source.origin||source.origin===snapshot.origin));
    if(sources.length===1){
      const source=sources[0];let action:BrowserAction|undefined;
      if(typeof source.value==='boolean'&&['checkbox','radio','switch'].includes(target.kind)&&target.checked!==source.value)action={type:'check',targetId:target.id,checked:source.value};
      if(typeof source.value==='string'&&(['textbox','spinbutton','slider'].includes(target.kind)||target.kind==='combobox'&&target.inputType)&&!target.readonly&&target.value!==source.value)action=target.inputType==='contenteditable'?{type:'replace',targetId:target.id,start:0,end:target.value?.length??0,text:source.value}:{type:'fill',targetId:target.id,value:source.value,backend:workflow.nativeInput&&['text','email','search','tel','url','textarea'].includes(target.inputType??'')?'native':'dom'};
      if(typeof source.value==='string'&&['combobox','listbox'].includes(target.kind)){
        const matches=target.options?.filter(option=>option.label===source.value&&!option.disabled);
        if(matches?.length===1&&!matches[0].selected)action={type:'select',targetId:target.id,indices:[matches[0].index]};
      }
      if(Array.isArray(source.value)&&target.kind==='listbox'&&target.multiple){const wanted=source.value,matches=wanted.map(label=>target.options?.filter(option=>option.label===label&&!option.disabled)??[]);if(matches.every(options=>options.length===1)&&new Set(wanted).size===wanted.length){const indices=matches.map(options=>options[0].index),selected=target.options?.filter(option=>option.selected).map(option=>option.index)??[];if(indices.slice().sort().join()!==selected.sort().join())action={type:'select',targetId:target.id,indices};}}
      if(action)operations.push({description:`Set ${target.name} to task-supplied ${JSON.stringify(source.value)}`.slice(0,300),action});
    }
    if(!(target.submitter&&target.formValid===false)&&(target.clickable||['button','link','menuitem','tab','option','treeitem'].includes(target.kind)||['combobox','listbox'].includes(target.kind)&&!target.options))operations.push({description:`Activate ${target.kind}: ${target.name}${target.section?' in '+target.section:''}`.slice(0,300),action:{type:'click',targetId:target.id,backend:workflow.nativeInput?'native':'dom'}});
    if(workflow.nativeInput&&['button','menuitem','treeitem','combobox'].includes(target.kind)){
      operations.push({description:`Hover ${target.kind}: ${target.name}`,action:{type:'hover',targetId:target.id}});
      if(!(target.submitter&&target.formValid===false))operations.push({description:`Focus ${target.kind}: ${target.name} and press Enter`,action:{type:'key',targetId:target.id,key:'Enter',shift:false}});
      if(target.expanded!==undefined)operations.push({description:`Focus ${target.name} and press Escape`,action:{type:'key',targetId:target.id,key:'Escape',shift:false}});
    }
  }
  for(const read of workflow.reads??[]){const targets=snapshot.targets.filter(target=>target.name===read.name&&(!read.section||target.section===read.section)&&(!read.origin||snapshot.origin===read.origin));if(targets.length===1){const {name,section,origin,...parameters}=read;operations.unshift({description:`Read task-requested ${read.format}: ${name}`,read:{...parameters,targetId:targets[0].id,offset:0,limit:16000}});}}
  if(!readonly&&workflow.nativeInput)for(const drag of workflow.drags??[]){const find=(spec:typeof drag.source)=>snapshot.targets.filter(target=>target.name===spec.name&&(!spec.section||target.section===spec.section)&&(!spec.origin||snapshot.origin===spec.origin)&&target.visible&&!target.disabled&&!target.secret),source=find(drag.source),destination=find(drag.destination);if(source.length===1&&destination.length===1)operations.unshift({description:`Drag ${source[0].name} to task-requested ${destination[0].name}`,action:{type:'drag',targetId:source[0].id,destinationId:destination[0].id}});}
  return operations;
}
