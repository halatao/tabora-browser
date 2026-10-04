/** Composed-tree helpers are bundled into the fixed sensor, never accepted as agent code. */
export function parentElement(el:Element):Element|null{
  const assigned=(el as HTMLElement).assignedSlot;if(assigned)return assigned;
  const parent=el.parentElement;
  // assignedSlot intentionally returns null for a slot inside a closed root.
  // The extension's authorized shadow API can still recover the composed parent.
  const shadow=parent instanceof HTMLElement?(parent.shadowRoot??(typeof chrome!=='undefined'?chrome.dom?.openOrClosedShadowRoot(parent):null)):null;
  if(shadow){const slots=shadow.querySelectorAll('slot');if(slots.length>1000)throw new Error('shadow_slot_limit');for(const slot of slots)if(slot.assignedNodes().includes(el))return slot;}
  return parent??(el.getRootNode() instanceof ShadowRoot?(el.getRootNode() as ShadowRoot).host:null);
}
export function ancestor(el:Element,selector:string):Element|null{
  for(let current:Element|null=el;current;current=parentElement(current))if(current.matches(selector))return current;
  return null;
}
export function visible(el:Element):boolean{
  const rect=el.getBoundingClientRect();
  if(!rect.width||!rect.height)return false;
  for(let current:Element|null=el;current;current=parentElement(current)){
    const style=getComputedStyle(current);
    if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.opacity==='0'||current.hasAttribute('hidden')||style.clipPath==='inset(50%)'||['rect(0000)','rect(0px0px0px0px)'].includes(style.clip.replace(/[ ,]/g,'')))return false;
  }
  return true;
}
export function content(el:Element,maxChars=1000000,includeHidden=false,exclude?:Element):string{
  const chunks:string[]=[],seen=new Set<Node>();let size=0,visited=0,lastBoundary=false;
  const append=(value:string,boundary=false)=>{if(size>=maxChars)return;const chunk=value.slice(0,maxChars-size);chunks.push(chunk);size+=chunk.length;lastBoundary=boundary;};
  const visit=(node:Node,depth:number)=>{
    if(node===exclude||size>=maxChars||seen.has(node))return;if(++visited>100000||depth>128)throw new Error('reader_size_limit');seen.add(node);
    if(node instanceof Text){append(node.data);return;}if(!(node instanceof Element))return;
    if(node.matches('script,style,noscript,template')||!includeHidden&&(node.hasAttribute('hidden')||getComputedStyle(node).display==='none'||getComputedStyle(node).visibility==='hidden'))return;
    if(node.matches('[data-private],[data-sensitive],input[type="password"],[autocomplete="current-password"],[autocomplete="new-password"]')){append('[redacted]');return;}
    if(node.matches('br')){append('\n');return;}
    const block=/^(block|flex|grid|table-row|list-item)$/.test(getComputedStyle(node).display);if(block&&size&&!chunks[chunks.length-1]?.endsWith('\n'))append('\n',true);
    const shadow=node.shadowRoot??(node instanceof HTMLElement&&typeof chrome!=='undefined'&&chrome.dom?chrome.dom.openOrClosedShadowRoot(node):null);
    const children=node instanceof HTMLSlotElement&&node.assignedNodes({flatten:true}).length?node.assignedNodes({flatten:true}):shadow?shadow.childNodes:node.childNodes;
    for(const child of children)visit(child,depth+1);if(block&&size&&!chunks[chunks.length-1]?.endsWith('\n'))append('\n',true);
  };
  if(ancestor(el,'[data-private],[data-sensitive]'))return '[redacted]';visit(el,0);const result=chunks.join('');return lastBoundary?result.slice(0,-1):result;
}
function normalized(value:string){return value.replace(/\s+/gu,' ').trim();}
export function accessibleName(el:Element,visited=new Set<Element>()):string{
  if(ancestor(el,'[data-private],[data-sensitive]'))return '[redacted]';
  if(visited.has(el))return '';visited.add(el);
  const root=el.getRootNode() as Document|ShadowRoot;
  const ids=el.getAttribute('aria-labelledby')?.trim().split(/\s+/).filter(Boolean)??[];
  const labelled=ids.map(id=>root.getElementById(id)).filter((e):e is HTMLElement=>!!e);
  if(labelled.length)return normalized(labelled.map(e=>accessibleName(e,visited)||content(e,500,true)||'').join(' ')).slice(0,500);
  const aria=el.getAttribute('aria-label');if(aria?.trim())return normalized(aria).slice(0,500);
  if(el instanceof HTMLInputElement||el instanceof HTMLSelectElement||el instanceof HTMLTextAreaElement){
    const labels=Array.from(el.labels??[]);if(labels.length)return normalized(labels.map(e=>content(e,500,true,el)).join(' ')).slice(0,500);
    if(el instanceof HTMLInputElement&&['button','submit','reset'].includes(el.type))return el.value;
  }
  if(el instanceof HTMLImageElement)return el.alt.slice(0,500);
  if(el.matches('body'))return 'Page body';
  if(el.matches('main,section,article,form,table,[role="region"],[role="grid"]')){const heading=Array.from(el.children).find(child=>child.matches('caption,legend,h1,h2,h3,[role="heading"]'));if(el.matches('main,[role="main"]')&&!heading)return 'Main content';return normalized(content(heading??el,500)).slice(0,500);}
  return normalized(content(el,500)||el.getAttribute('title')||el.getAttribute('placeholder')||el.getAttribute('name')||'').slice(0,500);
}
export function role(el:Element):string{
  const explicit=el.getAttribute('role')?.trim().split(/\s+/)[0];if(explicit)return explicit;
  if(el instanceof HTMLInputElement)return ({checkbox:'checkbox',radio:'radio',range:'slider',number:'spinbutton',button:'button',submit:'button',reset:'button',file:'file'} as Record<string,string>)[el.type]??'textbox';
  if(el instanceof HTMLSelectElement)return el.multiple?'listbox':'combobox';
  if(el instanceof HTMLTextAreaElement||el.getAttribute('contenteditable')==='true')return 'textbox';
  return ({A:'link',BUTTON:'button',TABLE:'table',TR:'row',TH:'columnheader',TD:'cell',FORM:'form',DIALOG:'dialog',IMG:'img',SVG:'img',CANVAS:'img',MAIN:'main',SECTION:'region',ARTICLE:'article'} as Record<string,string>)[el.tagName]??'generic';
}
export function description(el:Element):string|undefined{
  const root=el.getRootNode() as Document|ShadowRoot;
  const text=(el.getAttribute('aria-describedby')?.trim().split(/\s+/)??[]).map(id=>{const node=root.getElementById(id);return node?content(node,500):'';}).join(' ').trim();
  return text?normalized(text).slice(0,500):undefined;
}
export function section(el:Element):string|undefined{
  const container=ancestor(el,'dialog,[role="dialog"],section,article,form,[role="region"],fieldset');
  if(!container)return undefined;
  return accessibleName(container.querySelector('legend,h1,h2,h3,[role="heading"]')??container).slice(0,240)||undefined;
}
export function composedElements(root:Document|ShadowRoot|Element,max=5000):{elements:Element[];truncated:boolean}{
  const result:Element[]=[],seen=new Set<Element>(),queue:Element[]=root instanceof Element?[root]:Array.from(root.children).reverse();let truncated=false;
  while(queue.length&&result.length<max){
    const el=queue.pop()!;if(seen.has(el))continue;seen.add(el);result.push(el);
    const shadow=el.shadowRoot??(el instanceof HTMLElement&&typeof chrome!=='undefined'&&chrome.dom?chrome.dom.openOrClosedShadowRoot(el):null);
    const children=el instanceof HTMLSlotElement?el.assignedElements({flatten:true}):shadow?Array.from(shadow.children):Array.from(el.children);
    const capacity=max-result.length-queue.length;if(children.length>capacity)truncated=true;
    for(let i=Math.min(children.length,capacity)-1;i>=0;i--)queue.push(children[i]);
  }
  return {elements:result,truncated:truncated||queue.length>0};
}
