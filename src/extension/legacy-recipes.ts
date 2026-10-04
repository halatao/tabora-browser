import {PilotError,type Snapshot,type PageTarget} from '../shared.js';
import type {TargetV2,BrowserAction} from '../capabilities.js';

export type RecipeInput={op:'cancel'}|{op:'observe';kind:'click'|'fill'|'login'|'extract'|'all'}|{op:'wait';version:string;timeoutMs:number}|{op:'execute';origin:string;token:string;targetId:string;recipe:'click'|'fill'|'login'|'extract';fields?:Record<string,string>;selectOptionIndex?:number;credentialId?:string};
/** Public recipe compatibility is translation over V2, never a second page executor. */
export function legacyRecipes(call:(name:string,input:any)=>Promise<any>){
  let state:any;
  const versions=new Map<string,TargetV2[]>();
  async function table(targetId:string,maximum:number){
    let offset=0,revision:string|undefined;const rows:string[][]=[];let result:any;
    do{result=await call('read',{frameId:0,targetId,format:'rows',offset,limit:Math.min(100,maximum-rows.length),revision});revision??=result.revision;rows.push(...result.rows);if(result.nextOffset===null)break;if(result.nextOffset<=offset)throw new PilotError('reader_no_progress');offset=result.nextOffset;}while(rows.length<maximum);
    const truncation={rows:(result.totalRows??rows.length)>maximum||result.nextOffset!==null,columns:rows.some(row=>row.length>30),cells:rows.some(row=>row.slice(0,30).some(cell=>cell.length>120))};
    return {ok:true,rows:rows.slice(0,maximum).map(row=>row.slice(0,30).map(cell=>cell.slice(0,120))),truncation,truncated:!result.complete||Object.values(truncation).some(Boolean),rowCount:result.totalRows??rows.length};
  }
  async function observe(kind:string){
    state=await call('state',{frameId:0,cursor:0,limit:100});const targets:TargetV2[]=[...state.snapshot.targets];
    for(let page=1;state.snapshot.coverage.nextCursor!==null&&page<10;page++){state=await call('state',{frameId:0,cursor:state.snapshot.coverage.nextCursor,limit:100});targets.push(...state.snapshot.targets);}
    versions.clear();versions.set(state.snapshot.snapshotId,targets);
    const result:PageTarget[]=[];
    for(const target of targets){
      let projected:PageTarget|undefined;
      if(target.kind==='form'&&(kind!=='login'||targets.some(t=>t.formId===target.id&&t.secret&&t.inputPurpose!=='one-time-code')))projected={id:target.id,kind:'form',name:target.name,fields:targets.filter(t=>t.formId===target.id&&['textbox','combobox','spinbutton'].includes(t.kind)).map(t=>t.name),contains:targets.filter(t=>t.formId===target.id&&t.kind==='button').map(t=>t.name)};
      else if(target.kind==='combobox'&&target.options)projected={id:target.id,kind:'select',name:target.name,options:target.options.map(o=>({...o,placeholder:!o.label})),disabled:target.disabled};
      else if(['link','button'].includes(target.kind))projected={id:target.id,kind:target.kind as 'link'|'button',name:target.name,href:target.href?new URL(target.href).pathname+new URL(target.href).search:undefined,contains:target.contains,containsTruncated:target.containsTruncated,expanded:target.expanded};
      else if(['table','grid'].includes(target.kind)){const read=await table(target.id,6);projected={id:target.id,kind:'table',name:read.rows[0]?.join(' | ')??target.name,preview:read.rows,previewTruncated:read.truncated,section:target.section};}
      else if(target.kind==='file')projected={id:target.id,kind:'file',name:target.name,accept:target.accept,multiple:target.multiple};
      else if(target.name==='Page body')projected={id:target.id,kind:'text',name:'Obsah stránky'};
      if(projected&&(kind==='all'||kind==='extract'&&['table','text'].includes(projected.kind)||kind==='click'&&['link','button'].includes(projected.kind)||kind==='fill'&&['form','select'].includes(projected.kind)||kind==='login'&&projected.kind==='form')){projected.section??=target.section;result.push(projected);}
    }
    // Legacy recipe menus place the whole-page reader after concrete targets.
    result.sort((a,b)=>Number(a.kind==='text')-Number(b.kind==='text'));
    const body=targets.find(t=>t.name==='Page body');const text=body?(await call('read',{frameId:0,targetId:body.id,format:'text',offset:0,limit:3200})).text:'';
    const snapshot:Snapshot={origin:state.snapshot.origin,path:state.snapshot.path,title:state.snapshot.title,documentToken:state.snapshot.snapshotId,pageVersion:state.snapshot.dataVersion,dataVersion:state.snapshot.dataVersion,text,targets:result.slice(0,48),truncated:state.snapshot.coverage.truncated||result.length>48};
    return {ok:true,snapshot,limitations:{limit:48,truncated:snapshot.truncated}};
  }
  async function commit(action:BrowserAction){
    let result:any;
    try{const plan=await call('plan',{frameId:0,stateVersion:state.stateVersion,action,timeoutMs:3000});result=await call('commit',{actionId:plan.actionId,stateVersion:plan.stateVersion});}
    catch(error){if(error instanceof PilotError&&['stale_reference','unobserved_option'].includes(error.code))throw new PilotError('stale_snapshot');throw error;}
    if(result.readiness?.state==='scope_blocked')throw new PilotError('navigation_out_of_scope');
    if(result.action?.dispatch==='unknown'||result.action?.outcome==='unknown'||result.action?.outcome==='failed')throw new PilotError('action_outcome_unknown');
    state=result.snapshot?result:await call('state',{frameId:0,cursor:0,limit:100});return result;
  }
  return {async operation(input:RecipeInput):Promise<any>{
    if(input.op==='cancel'){state=undefined;versions.clear();return {ok:true};}
    if(input.op==='observe')return observe(input.kind);
    if(input.op==='wait'){
      const deadline=performance.now()+input.timeoutMs;
      do{const fresh=await call('state',{frameId:0,cursor:0,limit:100});if(fresh.snapshot.dataVersion!==input.version)return {ok:true,changed:true};await new Promise(r=>setTimeout(r,80));}while(performance.now()<deadline);
      return {ok:true,changed:false};
    }
    if(!state||state.snapshot.origin!==input.origin)throw new PilotError('stale_snapshot');
    const targets=versions.get(input.token),target=targets?.find(t=>t.id===input.targetId);if(!target)throw new PilotError('stale_snapshot');versions.delete(input.token);
    if(input.recipe==='extract'){const result=['table','grid'].includes(target.kind)?await table(target.id,101):await call('read',{frameId:0,targetId:target.id,format:'text',offset:0,limit:16000});return {ok:true,...result,section:target.section};}
    if(input.recipe==='login'){
      if(!input.credentialId)throw new PilotError('select_credential');
      return call('credential',{frameId:0,stateVersion:state.stateVersion,targetId:target.id,credentialId:input.credentialId});
    }
    if(input.recipe==='click'){const result=await commit({type:'click',targetId:target.id,backend:'dom'});return {ok:true,dispatched:true,verified:false,dispatch:result.action?.dispatch,outcome:result.action?.outcome??'unverified'};}
    if(input.selectOptionIndex!==undefined){if(target.kind!=='combobox'||!target.options?.some(o=>o.index===input.selectOptionIndex&&!o.disabled))throw new PilotError('invalid_option');await commit({type:'select',targetId:target.id,indices:[input.selectOptionIndex]});return {ok:true,filled:1,verified:true,submitted:false};}
    if(!input.fields||!Object.keys(input.fields).length)throw new PilotError('invalid_fields');
    const writes=Object.entries(input.fields).map(([name,value])=>{
      const matches=targets!.filter(t=>t.formId===target.id&&t.name===name&&!t.secret&&!t.disabled&&!t.readonly&&['textbox','combobox','spinbutton'].includes(t.kind));
      if(matches.length!==1)throw new PilotError('ambiguous_field');return {target:matches[0],value};
    });
    let filled=0;
    for(const write of writes){if(filled)state=await call('state',{frameId:0,cursor:0,limit:100});const action:BrowserAction=write.target.options?{type:'select',targetId:write.target.id,indices:write.target.options.filter(o=>o.label===write.value&&!o.disabled).map(o=>o.index)}:{type:'fill',targetId:write.target.id,value:write.value,backend:'dom'};if(action.type==='select'&&action.indices.length!==1)throw new PilotError('invalid_option');try{await commit(action);filled++;}catch(error){if(filled)throw new PilotError('partial_write');throw error;}}
    return {ok:true,filled,verified:true,submitted:false};
  }};
}
