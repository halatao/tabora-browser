import {PilotError} from '../shared.js';
import type {ObservedFrame} from './goal-plan.js';

/** One bounded observation scope for both planners. Continuations must retain provenance. */
export async function observeScope(call:(command:string,payload?:unknown)=>Promise<any>){
  const frames=await call('v2.frames'),allowed=frames.frames.filter((frame:any)=>frame.allowed);
  if(allowed.length>16)throw new PilotError('observation_scope_limit');
  const observations:ObservedFrame[]=[];
  for(const frame of allowed){
    let state=await call('v2.state',{frameId:frame.frameId,cursor:0,limit:100});
    const token=state.snapshot.provenance.documentToken,documentId=state.binding.documentId;
    const targets=[...state.snapshot.targets];
    for(let page=1;state.snapshot.coverage.nextCursor!==null&&page<10;page++){
      const cursor=state.snapshot.coverage.nextCursor,previous=state.snapshot.snapshotId;
      state=await call('v2.state',{frameId:frame.frameId,cursor,limit:100});
      if(state.binding.documentId!==documentId||state.snapshot.provenance.documentToken!==token||state.continuationOf!==previous)throw new PilotError('stale_continuation');
      targets.push(...state.snapshot.targets);
    }
    observations.push({frameId:frame.frameId,state:{...state,snapshot:{...state.snapshot,targets}}});
  }
  if(!observations.length)throw new PilotError('frame_not_permitted');
  return {frames,observations};
}
