import test from 'node:test';
import assert from 'node:assert/strict';
import {shadowRoot} from '../src/extension/semantic.js';

function fixture(run:(element:(name:string,root?:ShadowRoot)=>Element,calls:Element[],closed:Map<Element,ShadowRoot>)=>void){
  const previousHTMLElement=globalThis.HTMLElement,previousChrome=globalThis.chrome;
  class TestHTMLElement{constructor(readonly localName:string,readonly shadowRoot:ShadowRoot|null=null){}}
  const calls:Element[]=[],closed=new Map<Element,ShadowRoot>();
  (globalThis as any).HTMLElement=TestHTMLElement;
  (globalThis as any).chrome={dom:{openOrClosedShadowRoot:(element:Element)=>{calls.push(element);return closed.get(element)??null;}}};
  try{run((name,root)=>new TestHTMLElement(name,root) as unknown as Element,calls,closed);}
  finally{globalThis.HTMLElement=previousHTMLElement;globalThis.chrome=previousChrome;}
}

test('shadow lookup never passes form containers or ordinary controls to the extension API',()=>fixture((element,calls)=>{
  for(const name of ['form','input','select','textarea','button','fieldset','table','iframe','font-face','annotation-xml'])assert.equal(shadowRoot(element(name)),null,name);
  // HTML form named controls can shadow DOM properties; do not read it as a root.
  const form=element('form');Object.defineProperty(form,'shadowRoot',{get(){throw Error('form property read');}});
  assert.equal(shadowRoot(form),null);
  assert.equal(shadowRoot({localName:'div',shadowRoot:{}} as Element),null,'foreign namespace is not an HTML shadow host');
  assert.equal(calls.length,0);
}));

test('open and closed roots remain discoverable on built-in and Unicode custom hosts',()=>fixture((element,calls,closed)=>{
  const open={} as ShadowRoot,openHost=element('div',open);assert.equal(shadowRoot(openHost),open);assert.equal(calls.length,0);
  for(const name of ['body','span','article','h6','x-control','math-α','emotion-😍']){
    const host=element(name),root={} as ShadowRoot;closed.set(host,root);assert.equal(shadowRoot(host),root,name);
  }
  assert.equal(calls.length,7);
}));

test('a host that attaches a closed root later is observed without negative caching',()=>fixture((element,calls,closed)=>{
  const host=element('x-late');assert.equal(shadowRoot(host),null);
  const root={} as ShadowRoot;closed.set(host,root);assert.equal(shadowRoot(host),root);assert.equal(calls.length,2);
  globalThis.chrome.dom.openOrClosedShadowRoot=()=>{throw Error('shadow API failed');};
  assert.throws(()=>shadowRoot(host),/shadow API failed/);
}));
