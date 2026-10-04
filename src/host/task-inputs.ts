import type {Snapshot} from '../shared.js';

/** Candidates come only from the caller's goal, never instructions on a page. */
export function taskLiterals(goal:string):string[]{
  const quoted=[...goal.matchAll(/"([^"\n]{1,200})"|“([^”\n]{1,200})”|'([^'\n]{1,200})'/gu)].map(m=>m[1]??m[2]??m[3]);
  const tokens=[...goal.matchAll(/\b[\p{L}\p{N}][\p{L}\p{N}_.@:/+-]{1,99}\b/gu)].map(m=>m[0]);
  return [...new Set([...quoted,...tokens])].slice(0,30);
}

export function taskFillChoices(snapshot:Snapshot,goal:string){
  const values=taskLiterals(goal);
  return snapshot.targets.filter(t=>t.kind==='form'&&!t.disabled).flatMap(target=>
    (target.fields??[]).filter(name=>!/(?:password|passwd|secret|token|otp|one.time|credential|verification.code)/i.test(name))
      .slice(0,8).flatMap(field=>values.map(value=>({target,field,value}))));
}
