import {composedElements} from './semantic.js';

/** The plain text a browser user sees, including paragraph/BR line breaks. */
export function editorText(el:HTMLElement){
  const scan=composedElements(el);
  if(scan.truncated||scan.elements.some(node=>node.matches('[data-private],[data-sensitive],input[type="password"]')))throw new Error('sensitive_or_unsupported_editor');
  const value=el.innerText.replace(/\r\n/g,'\n');if(value.length>16000)throw new Error('editor_size_limit');return value;
}

export function editorRange(el:HTMLElement,start:number,end:number){
  const value=editorText(el);if(start<0||end<start||end>value.length)throw new Error('invalid_text_range');
  const range=document.createRange();
  if(start===0&&end===value.length){range.selectNodeContents(el);return {range,value};}
  const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),nodes:Text[]=[];let current:Node|null;
  while((current=walker.nextNode()))nodes.push(current as Text);
  // Map common paragraph/BR editors only when their DOM text exactly reproduces
  // rendered text. Complex layout, collapsed whitespace and virtual newlines with
  // no DOM position are refused before mutation.
  type Position=[Node,number];
  let positions:Map<number,Position>|undefined;
  if(nodes.map(node=>node.data).join('')!==value){
    positions=new Map();let rendered='';
    const line=(count:number)=>{if(rendered)while(rendered.length-rendered.replace(/\n+$/,'').length<count)rendered+='\n';};
    const visit=(node:Node)=>{
      if(node instanceof Text){for(let index=0;index<=node.length;index++)positions!.set(rendered.length+index,[node,index]);rendered+=node.data;return;}
      if(!(node instanceof HTMLElement))throw new Error('unsupported_editor_range');
      const style=getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden')return;
      if(node.tagName==='BR'){const parent=node.parentNode!,index=Array.from(parent.childNodes).indexOf(node);positions!.set(rendered.length,[parent,index]);rendered+='\n';positions!.set(rendered.length,[parent,index+1]);return;}
      const block=['block','list-item'].includes(style.display),spacing=node.tagName==='P'?2:1;
      if(block&&node!==el)line(spacing);
      for(const child of node.childNodes)visit(child);
      if(block&&node!==el)line(spacing);
    };
    visit(el);rendered=rendered.replace(/\n+$/,'');
    if(rendered!==value||!positions.has(start)||!positions.has(end))throw new Error('unsupported_editor_range');
  }
  const position=(offset:number):Position=>{if(positions)return positions.get(offset)!;for(const node of nodes){if(offset<=node.length)return [node,offset];offset-=node.length;}return [el,el.childNodes.length];};
  range.setStart(...position(start));range.setEnd(...position(end));return {range,value};
}
