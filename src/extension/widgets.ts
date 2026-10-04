import {visible} from './semantic.js';

/** An ARIA combobox may use a transparent/off-screen input inside its visible shell. */
export function ownedCombobox(el:Element):HTMLInputElement|undefined{
  if(el.matches('input,select,textarea,button,a,[role]'))return;
  const controls=Array.from(el.children).filter(child=>child.matches('input,[tabindex],button,select,textarea,a[href],[role]'));
  if(controls.length!==1||!(controls[0] instanceof HTMLInputElement))return;
  const input=controls[0];
  if(input.getAttribute('role')!=='combobox'||input.type==='password'||!input.getAttribute('aria-controls')||!input.getAttribute('aria-labelledby')&&!input.getAttribute('aria-label')||!visible(el)||visible(input))return;
  return input;
}
