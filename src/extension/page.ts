import type { Snapshot, PageTarget } from '../shared.js';
export type PageInput = {op:'cancel'} | {op:'observe';kind:'click'|'fill'|'login'|'extract'} | {op:'execute';origin:string;token:string;targetId:string;recipe:'click'|'fill'|'login'|'extract';fields?:Record<string,string>;credential?:{username:string;password:string}};

/** Serialized into Chrome's ISOLATED world; no external bindings or arbitrary code. */
export async function pageOperation(input: PageInput): Promise<any> {
  type Entry={el:Element;kind:PageTarget['kind'];fingerprint:string};
  type State={token:string;entries:Map<string,Entry>};
  const world=globalThis as typeof globalThis & {__browserPilot?:State;__browserPilotListening?:boolean};
  if(input.op==='cancel'){world.__browserPilot=undefined;return {ok:true};}
  if(!world.__browserPilotListening){
    document.addEventListener('input',event=>{if(event.isTrusted)world.__browserPilot=undefined;},true);
    world.__browserPilotListening=true;
  }
  const text=(value:string|null|undefined)=> (value??'').replace(/\s+/g,' ').trim().slice(0,120);
  const visible=(el:Element)=>{
    const r=el.getBoundingClientRect(),s=getComputedStyle(el);
    return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&s.opacity!=='0';
  };
  const name=(el:Element)=>{
    const field=el as HTMLInputElement;
    return text(el.getAttribute('aria-label') || field.labels?.[0]?.textContent || el.getAttribute('placeholder') || el.getAttribute('name') || (el instanceof HTMLInputElement ? '' : el.textContent));
  };
  const fields=(el:Element)=>Array.from(el.querySelectorAll('input,textarea,select')).filter(e=>visible(e)&&!['hidden','submit','button','reset','file','checkbox','radio'].includes((e as HTMLInputElement).type));
  const fingerprint=(el:Element)=>JSON.stringify({tag:el.tagName,name:name(el),href:el.getAttribute('href'),action:el.getAttribute('action'),fields:fields(el).map(e=>({tag:e.tagName,type:(e as HTMLInputElement).type,name:name(e),auto:e.getAttribute('autocomplete')}))});
  const assertReady=(el:Element)=>{
    if(!el.isConnected||!visible(el))throw new Error('target_not_ready');
    if((el as HTMLInputElement).disabled||el.getAttribute('aria-disabled')==='true'||el.closest('[inert]'))throw new Error('target_not_ready');
  };
  try {
    if(!['http:','https:'].includes(location.protocol))throw new Error('unsupported_page');
    if(input.op==='observe') {
      const selector=input.kind==='click'?'a[href],button,[role="button"],input[type="submit"]':input.kind==='extract'?'table':'form';
      const state:State={token:crypto.randomUUID(),entries:new Map()};world.__browserPilot=state;
      const targets:PageTarget[]=[];
      for(const el of Array.from(document.querySelectorAll(selector)).slice(0,1000)) {
        if(!visible(el))continue;
        const kind:PageTarget['kind']=el.matches('form')?'form':el.matches('table')?'table':el.matches('a')?'link':'button';
        if(input.kind==='login'&&!fields(el).some(e=>(e as HTMLInputElement).type==='password'))continue;
        const fieldNames=kind==='form'?fields(el).map(name):kind==='table'?Array.from(el.querySelectorAll('th')).slice(0,20).map(e=>text(e.textContent)):undefined;
        const label=(kind==='form'?text(el.getAttribute('aria-label')||el.getAttribute('name')||fieldNames?.join(' · ')):kind==='table'?text(el.querySelector('caption')?.textContent||fieldNames?.join(' · ')||'Tabulka'):name(el)||text((el as HTMLInputElement).value)) || kind;
        const id='e'+targets.length;targets.push({id,kind,name:label,fields:fieldNames});
        state.entries.set(id,{el,kind,fingerprint:fingerprint(el)});
        if(targets.length>=48)break;
      }
      const snapshot:Snapshot={documentToken:state.token,origin:location.origin,path:location.pathname,targets};
      return {ok:true,snapshot,limitations:{iframes:document.querySelectorAll('iframe').length,limit:48}};
    }
    const state=world.__browserPilot,entry=state?.entries.get(input.targetId);
    if(!state||state.token!==input.token||location.origin!==input.origin||!entry)throw new Error('stale_snapshot');
    const check=()=>{assertReady(entry.el);if(world.__browserPilot!==state||location.origin!==input.origin||fingerprint(entry.el)!==entry.fingerprint)throw new Error('stale_snapshot');};
    check();
    if(input.recipe==='extract') {
      if(entry.kind!=='table')throw new Error('wrong_target_kind');
      const rows=Array.from(entry.el.querySelectorAll('tr')).slice(0,101).map(row=>Array.from(row.querySelectorAll('th,td')).slice(0,30).map(cell=>text(cell.textContent)));
      state.entries.delete(input.targetId);return {ok:true,rows,truncated:entry.el.querySelectorAll('tr').length>101};
    }
    if(input.recipe==='click') {
      if(!['link','button'].includes(entry.kind))throw new Error('wrong_target_kind');
      if(entry.el instanceof HTMLAnchorElement){const url=new URL(entry.el.href);if(!['https:','http:'].includes(url.protocol)||url.origin!==input.origin)throw new Error('navigation_out_of_scope');}
      entry.el.scrollIntoView({block:'center',behavior:'instant'});
      // Synchronous geometry flush also works in background tabs where rAF is suspended.
      check();const r=entry.el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      if(!hit||!(entry.el===hit||entry.el.contains(hit)))throw new Error('target_obscured');
      if(entry.el instanceof HTMLAnchorElement&&new URL(entry.el.href).origin!==input.origin)throw new Error('navigation_out_of_scope');
      state.entries.delete(input.targetId);
      (entry.el as HTMLElement).click();
      // Dispatch acknowledgement is not proof of the application's business outcome.
      return {ok:true,dispatched:true,verified:false};
    }
    if(entry.kind!=='form')throw new Error('wrong_target_kind');
    const available=fields(entry.el);
    let writes:{element:HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement;value:string}[]=[];
    if(input.recipe==='login') {
      if(location.protocol!=='https:'||!input.credential)throw new Error('credential_scope_mismatch');
      const passwords=available.filter(e=>(e as HTMLInputElement).type==='password');
      const usernames=available.filter(e=>e instanceof HTMLInputElement&&['text','email'].includes(e.type));
      if(passwords.length!==1||usernames.length!==1)throw new Error('ambiguous_login_form');
      writes=[{element:usernames[0] as HTMLInputElement,value:input.credential.username},{element:passwords[0] as HTMLInputElement,value:input.credential.password}];
    } else {
      if(!input.fields||!Object.keys(input.fields).length||Object.keys(input.fields).length>20)throw new Error('invalid_fields');
      for(const [label,value] of Object.entries(input.fields)) {
        if(typeof value!=='string'||value.length>2000)throw new Error('invalid_fields');
        const matching=available.filter(e=>name(e)===label);
        if(matching.length!==1||(matching[0] as HTMLInputElement).type==='password')throw new Error('ambiguous_field');
        writes.push({element:matching[0] as HTMLInputElement,value});
      }
    }
    for(const {element,value} of writes) {
      assertReady(element);if((element as HTMLInputElement).readOnly)throw new Error('field_readonly');
      if(element instanceof HTMLSelectElement&&!Array.from(element.options).some(o=>o.value===value))throw new Error('invalid_option');
    }
    // References are document-bound; no focus + global keyboard sequence for passwords.
    state.entries.delete(input.targetId);let filled=0;
    try {
      for(const {element,value} of writes) {
        assertReady(element);if(location.origin!==input.origin)throw new Error('stale_snapshot');
        const proto=element instanceof HTMLInputElement?HTMLInputElement.prototype:element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLSelectElement.prototype;
        const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(!setter)throw new Error('unsupported_field');
        setter.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));
        if(!element.isConnected||element.value!==value)throw new Error('verification_failed');filled++;
      }
      return {ok:true,filled,verified:true,submitted:false};
    } catch {return {ok:false,code:'partial_write',filled};}
  } catch(error) {
    const allowed=['unsupported_page','stale_snapshot','target_not_ready','wrong_target_kind','navigation_out_of_scope','target_obscured','credential_scope_mismatch','ambiguous_login_form','invalid_fields','ambiguous_field','field_readonly','invalid_option'];
    const code=error instanceof Error&&allowed.includes(error.message)?error.message:'execution_failed';
    return {ok:false,code};
  }
}
