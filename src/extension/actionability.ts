import {ancestor,parentElement,visible} from './semantic.js';
import {ownedCombobox} from './widgets.js';
export function ready(el:Element,editable=false){
  if(!el.isConnected||!visible(el)||el.matches(':disabled')||el.getAttribute('aria-disabled')==='true'||ancestor(el,'[inert]'))throw new Error('target_not_ready');
  const widget=ownedCombobox(el);if(widget&&(widget.disabled||widget.getAttribute('aria-disabled')==='true'))throw new Error('target_not_ready');
  if(editable&&(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement)&&el.readOnly)throw new Error('field_readonly');
  const modal=document.querySelector('dialog:modal')??Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).find(visible);
  if(modal&&!modal.contains(el)&&ancestor(el,'dialog,[role="dialog"]')!==modal)throw new Error('modal_blocked');
}
function deepHit(x:number,y:number):Element|null{
  let hit=document.elementFromPoint(x,y);
  for(let depth=0;hit&&depth<10;depth++){
    const shadow=hit.shadowRoot??(hit instanceof HTMLElement?chrome.dom?.openOrClosedShadowRoot(hit):null),inner=shadow?.elementFromPoint(x,y);
    if(!inner||inner===hit)break;hit=inner;
  }
  return hit;
}
function belongs(el:Element,hit:Element){for(let current:Element|null=hit;current;current=parentElement(current))if(current===el)return true;return false;}
export function exposedPoint(el:Element,desired?:{x:number;y:number}):{x:number;y:number}{
  const find=()=>{
    ready(el);const rect=el.getBoundingClientRect(),left=Math.max(0,rect.left),right=Math.min(innerWidth,rect.right),top=Math.max(0,rect.top),bottom=Math.min(innerHeight,rect.bottom);
    if(right<=left||bottom<=top)return;
    if(desired){if(desired.x<left||desired.x>=right||desired.y<top||desired.y>=bottom)return;const hit=deepHit(desired.x,desired.y);if(hit&&belongs(el,hit))return desired;return;}
    for(const fx of [.5,.15,.85])for(const fy of [.5,.15,.85]){const x=left+(right-left)*fx,y=top+(bottom-top)*fy,hit=deepHit(x,y);if(hit&&belongs(el,hit))return {x,y};}
  };
  // Do not scroll a currently exposed target: a virtual list can recycle its
  // node during an unnecessary scrollIntoView before pointer dispatch.
  const exposed=find();if(exposed)return exposed;
  if(!desired){el.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});const scrolled=find();if(scrolled)return scrolled;}
  throw new Error('target_obscured');
}
