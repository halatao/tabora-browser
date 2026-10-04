import type {BrowserAction} from '../capabilities.js';
import {ancestor} from './semantic.js';
import {Registry} from './registry.js';
import {ready,exposedPoint} from './actionability.js';
import {editorRange,editorText} from './editor.js';

export function domAction(registry:Registry,action:BrowserAction,allowedOrigins:string[]=[]):Record<string,unknown>{
  const entry=registry.resolve(action.targetId,true),el=entry.el;if(['fill','replace','check','select'].includes(action.type)&&(ancestor(el,'[data-private],[data-sensitive]')||entry.target.secret||['current-password','new-password','one-time-code'].includes(el.getAttribute('autocomplete')?.trim().split(/\s+/).at(-1)??'')))throw new Error('sensitive_or_unsupported_field');ready(el,['fill','replace'].includes(action.type));
  if(action.type==='navigate'){if(!(el instanceof HTMLAnchorElement))throw new Error('wrong_target_kind');const url=new URL(el.href);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.origin!==location.origin&&!allowedOrigins.includes(url.origin))throw new Error('navigation_out_of_scope');location.assign(url.href);return {dispatch:'sent',outcome:'unverified',backend:'browser_navigation'};}
  if(action.type==='click'){
    if(action.backend!=='dom')throw new Error('native_backend_required');
    exposedPoint(el);
    if(el instanceof HTMLAnchorElement){const url=new URL(el.href);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.origin!==location.origin&&!allowedOrigins.includes(url.origin))throw new Error('navigation_out_of_scope');}
    if(!(el instanceof HTMLElement))throw new Error('native_backend_required');
    el.click();return {dispatch:'sent',outcome:'unverified'};
  }
  if(action.type==='scroll'){
    const before={x:el.scrollLeft,y:el.scrollTop};el.scrollBy({left:action.x,top:action.y,behavior:'instant'});
    return {dispatch:'sent',outcome:'verified',scroll:{x:el.scrollLeft,y:el.scrollTop},progress:before.x!==el.scrollLeft||before.y!==el.scrollTop};
  }
  if(['key','hover','drag'].includes(action.type))throw new Error('native_backend_required');
  if(action.type==='check'){
    if(!(el instanceof HTMLInputElement)||!['checkbox','radio'].includes(el.type))throw new Error('native_backend_required');
    if(el.checked===action.checked&&!el.indeterminate)return {dispatch:'not_needed',outcome:'verified',checked:el.checked};
    if(el.type==='radio'&&!action.checked)throw new Error('unsupported_radio_uncheck');
    exposedPoint(el);el.click();if(el.checked!==action.checked||el.indeterminate)return {dispatch:'sent',outcome:'failed',code:'verification_failed'};
    return {dispatch:'sent',outcome:'verified',checked:el.checked};
  }
  if(action.type==='select'){
    registry.validateOptions(action.targetId,action.indices);
    if(!(el instanceof HTMLSelectElement)||!el.multiple&&action.indices.length!==1)throw new Error('wrong_target_kind');
    const indices=new Set(action.indices);if(indices.size!==action.indices.length)throw new Error('invalid_option');
    for(const index of indices){const option=el.options[index];if(!option||option.disabled||option.hidden||option.closest('optgroup[disabled]'))throw new Error('invalid_option');}
    for(const option of el.options)option.selected=indices.has(option.index);
    el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));
    if(Array.from(el.selectedOptions).map(o=>o.index).sort().join()!==[...indices].sort().join())return {dispatch:'sent',outcome:'failed',code:'verification_failed'};
    return {dispatch:'sent',outcome:'verified',indices:[...indices]};
  }
  if(action.type==='fill'){
    if(action.backend==='native')throw new Error('native_backend_required');
    if(!(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement))throw new Error('wrong_target_kind');
    if(el instanceof HTMLInputElement&&['password','file','hidden','checkbox','radio','button','submit','reset'].includes(el.type))throw new Error('sensitive_or_unsupported_field');
    const previous=el.value,prototype=el instanceof HTMLInputElement?HTMLInputElement.prototype:HTMLTextAreaElement.prototype,setter=Object.getOwnPropertyDescriptor(prototype,'value')?.set;
    if(!setter)throw new Error('unsupported_field');
    setter.call(el,action.value);
    if(el.value!==action.value||!el.validity.valid){setter.call(el,previous);throw new Error('invalid_field_value');}
    el.dispatchEvent(new Event('input',{bubbles:true,composed:true}));el.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
    if(!el.isConnected||el.value!==action.value)return {dispatch:'sent',outcome:'unknown',code:'verification_failed'};
    return {dispatch:'sent',outcome:'verified',value:el.value};
  }
  if(action.type==='replace'){
    if(!(el instanceof HTMLElement)||!el.isContentEditable)throw new Error('wrong_target_kind');
    const {range,value}=editorRange(el,action.start,action.end);
    el.focus();const selection=document.getSelection();selection?.removeAllRanges();selection?.addRange(range);
    const multiline=action.text.includes('\n');
    const inserted=multiline?action.text.split('\n').map(line=>line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')).join('<br>'):action.text;
    // Explicit BRs avoid Chromium creating extra paragraph breaks when pasting
    // multiline text into an existing paragraph. Every character is escaped.
    if(!document.execCommand(multiline?'insertHTML':'insertText',false,inserted))throw new Error('native_backend_required');
    const expected=value.slice(0,action.start)+action.text+value.slice(action.end);
    if(editorText(el)!==expected)return {dispatch:'sent',outcome:'unknown',code:'verification_failed'};return {dispatch:'sent',outcome:'verified'};
  }
  throw new Error('unsupported_action');
}
