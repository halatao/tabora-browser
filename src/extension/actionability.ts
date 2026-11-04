import {ancestor,parentElement,shadowRoot,visible,accessibleName,role} from './semantic.js';
import type {ActionDiagnostic} from '../shared.js';
export class ExposureError extends Error{constructor(code:string,readonly details:ActionDiagnostic){super(code);}}
function blocker(el:Element){return {tag:el.tagName.slice(0,40),id:el.id.slice(0,120),className:(el.getAttribute('class')??'').slice(0,240),role:role(el).slice(0,60),name:ancestor(el,'[data-private],[data-sensitive]')?'':accessibleName(el).slice(0,240)};}
import {ownedCombobox} from './widgets.js';
export function ready(el:Element,editable=false){
  if(!el.isConnected||!visible(el)||el.matches(':disabled')||el.getAttribute('aria-disabled')==='true'||ancestor(el,'[inert]'))throw new Error('target_not_ready');
  const widget=ownedCombobox(el);if(widget&&(widget.disabled||widget.getAttribute('aria-disabled')==='true'))throw new Error('target_not_ready');
  if(editable&&(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement)&&el.readOnly)throw new Error('field_readonly');
  const modal=document.querySelector('dialog:modal')??Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).find(visible);
  if(modal&&!modal.contains(el)&&ancestor(el,'dialog,[role="dialog"]')!==modal)throw new ExposureError('modal_blocked',{blockers:[blocker(modal)]});
}
function deepHit(x:number,y:number):Element|null{
  let hit=document.elementFromPoint(x,y);
  for(let depth=0;hit&&depth<10;depth++){
    const inner=shadowRoot(hit)?.elementFromPoint(x,y);
    if(!inner||inner===hit)break;hit=inner;
  }
  return hit;
}
function belongs(el:Element,hit:Element){for(let current:Element|null=hit;current;current=parentElement(current))if(current===el)return true;return false;}
export function exposedPoint(el:Element,desired?:{x:number;y:number}):{x:number;y:number}{
  const blockers=new Set<Element>();let outside=false;
  const find=()=>{
    ready(el);const rect=el.getBoundingClientRect(),left=Math.max(0,rect.left),right=Math.min(innerWidth,rect.right),top=Math.max(0,rect.top),bottom=Math.min(innerHeight,rect.bottom);
    blockers.clear();outside=right<=left||bottom<=top;
    if(outside)return;
    if(desired){if(desired.x<left||desired.x>=right||desired.y<top||desired.y>=bottom)return;const hit=deepHit(desired.x,desired.y);if(hit&&belongs(el,hit))return desired;if(hit)blockers.add(hit);return;}
    for(const fx of [.5,.15,.85])for(const fy of [.5,.15,.85]){const x=left+(right-left)*fx,y=top+(bottom-top)*fy,hit=deepHit(x,y);if(hit&&belongs(el,hit))return {x,y};if(hit)blockers.add(hit);}
  };
  // Do not scroll a currently exposed target: a virtual list can recycle its
  // node during an unnecessary scrollIntoView before pointer dispatch.
  const exposed=find();if(exposed)return exposed;
  if(!desired){
    el.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});const scrolled=find();if(scrolled)return scrolled;
    // Nearest can leave an in-viewport target behind a fixed header/footer.
    // Reposition only after occlusion, then repeat the same live hit-test.
    el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});const centered=find();if(centered)return centered;
  }
  const rect=el.getBoundingClientRect();
  throw new ExposureError('target_obscured',{blockers:[...blockers].slice(0,9).map(blocker),phase:'actionability',cause:outside?'outside_viewport':'overlay',dispatch:'not_sent',nextStep:outside?'observe':'inspect_blocker',geometry:{x:rect.x,y:rect.y,width:rect.width,height:rect.height,viewportWidth:innerWidth,viewportHeight:innerHeight}});
}
/** Retry preparation only. Every yield must recheck the original observed identity. */
export async function waitExposedPoint(resolve:()=>Element,desired?:{x:number;y:number},timeoutMs=2000){
  const started=performance.now();let attempts=0,last:ExposureError|undefined;
  do{
    const el=resolve();attempts++;
    try{
      const point=exposedPoint(el,desired);
      if(last){resolve();return exposedPoint(el,desired);}
      return point;
    }catch(error){if(!(error instanceof ExposureError))throw error;last=error;}
    const remaining=timeoutMs-(performance.now()-started);if(remaining<=0)break;
    await new Promise(resolve=>setTimeout(resolve,Math.min(50,remaining)));
  }while(true);
  throw new ExposureError(last!.message,{...last!.details,attempts,elapsedMs:Math.round(performance.now()-started),deadlineMs:timeoutMs});
}
