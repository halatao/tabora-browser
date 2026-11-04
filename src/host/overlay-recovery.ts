import type {ActionDiagnostic} from '../shared.js';
import type {ObservedFrame} from './goal-plan.js';

/** Only an observed non-form informational dialog may gain a corrective close choice. */
export function overlayRecovery(frames:ObservedFrame[],diagnostic:ActionDiagnostic|undefined){
  if(!diagnostic||diagnostic.dispatch!=='not_sent')return [];
  return frames.flatMap(({frameId,state})=>{
    const targets=state.snapshot.targets;
    const dialogs=targets.filter(target=>target.kind==='dialog'&&target.visible&&!target.disabled&&target.name&&diagnostic.blockers.some(blocker=>blocker.role==='dialog'&&blocker.name===target.name));
    return dialogs.flatMap(dialog=>{
      const children=targets.filter(target=>target.section===dialog.name);
      if(children.some(target=>target.secret||target.kind==='form'||target.inputType||['textbox','checkbox','radio','combobox','switch','spinbutton'].includes(target.kind)))return [];
      if(/payment|checkout|sign.?in|log.?in|authenticat|unsaved|discard|delete|confirm|platb|přihl|neuložen|smaz|potvr/i.test(dialog.name+' '+children.map(target=>target.name).join(' ')))return [];
      const close=children.filter(target=>target.kind==='button'&&target.visible&&!target.disabled&&!target.submitter&&/^(close|dismiss|close dialog|dismiss dialog|zavřít|×|✕)$/i.test(target.name));
      if(close.length!==1)return [];
      return [{description:'Close the observed informational overlay using its explicit close button; then reobserve the original task',action:{type:'click' as const,targetId:close[0].id,backend:'dom' as const},frameId,stateVersion:state.stateVersion,snapshot:state.snapshot}];
    });
  });
}
