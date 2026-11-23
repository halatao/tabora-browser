import {Registry} from './registry.js';
import {ancestor,visible} from './semantic.js';
import {ready} from './actionability.js';

export interface PasswordFields {passwordTargetId:string;confirmationTargetId?:string;currentPasswordTargetId?:string;}
export function passwordFields(registry:Registry,snapshotId:string,fields:PasswordFields){
  const baseline=registry.snapshots.get(snapshotId);if(!baseline)throw new Error('stale_snapshot');
  const ids=[fields.passwordTargetId,fields.confirmationTargetId,fields.currentPasswordTargetId].filter((id):id is string=>!!id);
  if(ids.length!==new Set(ids).size)throw new Error('ambiguous_password_fields');
  const inputs=ids.map(id=>{
    if(!baseline.targets.some(t=>t.id===id&&t.inputType==='password'))throw new Error('wrong_target_kind');
    const el=registry.resolve(id,true).el;
    if(!(el instanceof HTMLInputElement)||el.type!=='password'||!visible(el))throw new Error('wrong_target_kind');
    ready(el,true);
    if(el.readOnly||ancestor(el,'[data-private],[data-sensitive]')||el.autocomplete==='one-time-code')throw new Error('field_readonly');
    if(id===fields.currentPasswordTargetId?el.autocomplete==='new-password':el.autocomplete==='current-password')throw new Error('password_field_purpose_mismatch');
    return el;
  });
  if(inputs.some(el=>el.form!==inputs[0].form))throw new Error('ambiguous_password_fields');
  return ids.map((id,i)=>({id,el:inputs[i]}));
}
export function fillPasswordFields(registry:Registry,snapshotId:string,fields:PasswordFields,secrets:{password:string;currentPassword?:string}){
  const writes=passwordFields(registry,snapshotId,fields);
  if(fields.currentPasswordTargetId&&!secrets.currentPassword)throw new Error('current_credential_missing');
  let filled=0;
  try{
    for(const {id,el} of writes){
      // Input handlers may replace another field or change its purpose synchronously.
      passwordFields(registry,snapshotId,fields);
      const value=id===fields.currentPasswordTargetId?secrets.currentPassword!:secrets.password;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(el,value);
      el.dispatchEvent(new Event('input',{bubbles:true,composed:true}));el.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
      if(!el.isConnected||el.value!==value)throw new Error('verification_failed');filled++;
    }
    return {ok:true,filled,verified:true,submitted:false};
  }catch{return {ok:true,filled,verified:false,code:'partial_write',submitted:false};}
  finally{registry.snapshots.delete(snapshotId);}
}
