import type {ObservationV2,TargetV2,BrowserAction} from '../src/capabilities.js';
export function control(id:string,kind:string,name:string,extra:Partial<TargetV2>={}):TargetV2{return {id,kind,role:kind,name,disabled:false,readonly:false,visible:true,...extra};}
export function fixture(targets:TargetV2[],text=''){
  let revision=0,action:BrowserAction|undefined;
  const snapshot=():ObservationV2=>({schemaVersion:2,snapshotId:'snapshot-'+revision,epoch:revision,dataVersion:String(revision),origin:'https://fixture.test',path:'/dashboard',title:'Dashboard',targets,coverage:{scanned:targets.length,targetCount:targets.length,truncated:false,cursor:0,nextCursor:null},provenance:{source:'page',trust:'untrusted',documentToken:'token'}});
  const hooks={decision:async(_input:any):Promise<any>=>({status:'selected',choiceId:'handoff',latencyMs:0}),commit:async():Promise<any>=>({action:{dispatch:'sent',outcome:'verified'}}),read:async(_input:any):Promise<any>=>({text,complete:true,truncated:false,nextOffset:null,provenance:{documentToken:'token'}})};
  const commands:string[]=[];
  const call=async(command:string,input:any):Promise<any>=>{
    commands.push(command);
    if(command==='v2.capabilities')return {capabilities:{nativeInput:{status:'available'},capture:{status:'available'}}};
    if(command==='v2.frames')return {frames:[{frameId:0,allowed:true}]};
    if(command==='v2.state')return {stateVersion:'document:snapshot-'+revision,binding:{documentId:'document',origin:'https://fixture.test'},snapshot:snapshot()};
    if(command==='v2.read')return hooks.read(input);
    if(command==='select')return hooks.decision(input);
    if(command==='v2.plan'){action=input.action;return {actionId:'prepared',stateVersion:input.stateVersion};}
    if(command==='v2.commit'){revision++;return hooks.commit();}
    if(command==='cancel')return {cancelled:true};
    throw Error('Unexpected command '+command);
  };
  return {targets,hooks,commands,call,get action(){return action;},setText(value:string){text=value;revision++;}};
}
