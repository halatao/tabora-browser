import {z} from 'zod';
import {runOptions} from '../browser-api.js';
import {PilotError,type ProviderId} from '../shared.js';

/** Authentication/session ownership are checked by each transport before admission. */
export function admitRun(raw:unknown,preferred:ProviderId|'agent'|undefined,readonly:boolean){
  const input=z.object(runOptions).strict().parse(raw);
  const provider=input.provider??preferred??'agent';
  if(preferred&&preferred!=='agent'&&provider!==preferred)throw new PilotError('provider_preference_mismatch');
  if(provider==='agent')throw new PilotError('decision_provider_required');
  return {goal:input.goal,provider,options:{maxSteps:input.maxSteps,timeoutMs:input.timeoutMs,readonly,task:input.task,workflow:input.workflow}};
}
