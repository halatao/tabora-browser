import type { Snapshot, PageTarget } from '../shared.js';
export type PageInput = {op:'cancel'} | {op:'observe';kind:'click'|'fill'|'login'|'extract'|'all'} | {op:'wait';version:string;timeoutMs:number} | {op:'execute';origin:string;token:string;targetId:string;recipe:'click'|'fill'|'login'|'extract';fields?:Record<string,string>;selectOptionIndex?:number;credential?:{username:string;password:string}};

/** Serialized into Chrome's ISOLATED world; no external bindings or arbitrary code. */
export async function pageOperation(input: PageInput): Promise<any> {
  type Entry={el:Element;kind:PageTarget['kind'];fingerprint:string;optionIndices?:number[]};
  type State={token:string;entries:Map<string,Entry>};
  const world=globalThis as typeof globalThis & {__browserPilot?:State;__browserPilotListening?:boolean};
  if(input.op==='cancel'){world.__browserPilot=undefined;return {ok:true};}
  if(!world.__browserPilotListening){
    document.addEventListener('input',event=>{if(event.isTrusted)world.__browserPilot=undefined;},true);
    world.__browserPilotListening=true;
  }
  const text=(value:string|null|undefined)=> (value??'').replace(/\s+/g,' ').trim().slice(0,120);
  const rendered=(el:Element)=>{if(el.closest('[data-private],[data-sensitive]'))return '[REDACTED]';let value=el instanceof HTMLElement?el.innerText:el.textContent??'';for(const sensitive of el.querySelectorAll('[data-private],[data-sensitive]')){const text=sensitive instanceof HTMLElement?sensitive.innerText:sensitive.textContent??'';if(text)value=value.split(text).join('[REDACTED]');}return value;};
  const visible=(el:Element)=>{
    const r=el.getBoundingClientRect(),s=getComputedStyle(el);
    return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&s.opacity!=='0';
  };
  const name=(el:Element)=>{
    const field=el as HTMLInputElement;
    const label=field.labels?.[0],labelText=label?rendered(label).replace(rendered(el),''):'';
    return text(el.getAttribute('aria-label') || labelText || el.getAttribute('placeholder') || el.getAttribute('name') || (el instanceof HTMLSelectElement?el.id:'') || (el instanceof HTMLInputElement ? '' : rendered(el)));
  };
  const fields=(el:Element)=>(el instanceof HTMLSelectElement?[el]:Array.from(el.querySelectorAll('input,textarea,select'))).filter(e=>visible(e)&&!['hidden','submit','button','reset','file','checkbox','radio'].includes((e as HTMLInputElement).type));
  const hash=(value:string)=>{let result=2166136261;for(let i=0;i<value.length;i++)result=Math.imul(result^value.charCodeAt(i),16777619);return String(result>>>0);};
  const dataVersion=()=>{
    const main=document.querySelector('main,[role="main"]')??document.body;
    let value=rendered(main).slice(0,32000);
    for(const nav of main.querySelectorAll('nav,[role="navigation"]'))value=value.replace(rendered(nav),'');
    return hash(location.pathname+' '+value);
  };
  const pageVersion=()=>{
    const value=location.pathname+' '+(document.body?.innerText??'').slice(0,32000)+' '+Array.from(document.querySelectorAll('[aria-expanded]')).slice(0,100).map(e=>e.getAttribute('aria-expanded')).join()+' '+Array.from(document.querySelectorAll('select')).filter(visible).slice(0,100).map(e=>e.selectedIndex);
    return hash(value);
  };
  const section=(el:Element)=>{
    for(let parent=el.parentElement,depth=0;parent&&parent!==document.body&&depth<5;parent=parent.parentElement,depth++){
      const label=parent.getAttribute('aria-label');if(label)return text(label);
      const heading=Array.from(parent.querySelectorAll('h1,h2,h3,h4,[role="heading"],.dashboard-item-title')).find(h=>!!(h.compareDocumentPosition(el)&Node.DOCUMENT_POSITION_FOLLOWING)&&visible(h));
      if(heading)return text(rendered(heading));
    }
    return undefined;
  };
  const fingerprint=(el:Element)=>JSON.stringify({tag:el.tagName,name:name(el),href:el.getAttribute('href'),action:el.getAttribute('action'),fields:fields(el).map(e=>({tag:e.tagName,type:(e as HTMLInputElement).type,name:name(e),auto:e.getAttribute('autocomplete'),...(e instanceof HTMLSelectElement?{value:e.value,options:Array.from(e.options).map(o=>({value:o.value,label:o.text,disabled:o.disabled||!!o.closest('optgroup[disabled]')}))}:{})}))});
  const assertReady=(el:Element)=>{
    if(!el.isConnected||!visible(el))throw new Error('target_not_ready');
    if((el as HTMLInputElement).disabled||el.matches(':disabled')||el.getAttribute('aria-disabled')==='true'||el.closest('[inert]'))throw new Error('target_not_ready');
  };
  try {
    if(!['http:','https:'].includes(location.protocol))throw new Error('unsupported_page');
    if(input.op==='wait')return await new Promise(resolve=>{
      let stable:ReturnType<typeof setTimeout>|undefined;
      const finish=(changed:boolean)=>{observer.disconnect();clearTimeout(deadline);clearTimeout(stable);resolve({ok:true,changed,readyState:document.readyState});};
      const check=()=>{clearTimeout(stable);const loading=Array.from(document.querySelectorAll('[aria-busy="true"],[data-role="loader"],.loading-mask')).some(visible);if(!loading&&pageVersion()!==input.version)stable=setTimeout(()=>finish(true),120);};
      const observer=new MutationObserver(check);observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['aria-expanded','hidden','class','style','aria-busy']});
      const deadline=setTimeout(()=>finish(false),Math.min(10000,Math.max(100,input.timeoutMs)));check();
    });
    if(input.op==='observe') {
      const selector=input.kind==='all'?'table,form,select,input[type="file"],a[href],button,[role="button"],[role="menuitem"],input[type="submit"]':input.kind==='click'?'a[href],button,[role="button"],[role="menuitem"],input[type="submit"]':input.kind==='extract'?'table':input.kind==='fill'?'form,select,input[type="file"]':'form';
      const state:State={token:crypto.randomUUID(),entries:new Map()};world.__browserPilot=state;
      const targets:PageTarget[]=[];
      const elements=Array.from(document.querySelectorAll(selector)).slice(0,1000);
      if(input.kind==='all')elements.sort((a,b)=>Number(b.matches('table,form,select'))-Number(a.matches('table,form,select')));
      let previewBudget=6000,optionBudget=6000;
      for(const el of elements) {
        if(!visible(el)&&!el.matches('input[type="file"]'))continue;
        const kind:PageTarget['kind']=el.matches('form')?'form':el.matches('table')?'table':el.matches('select')?'select':el.matches('input[type="file"]')?'file':el.matches('a')?'link':'button';
        if(input.kind==='login'&&!fields(el).some(e=>(e as HTMLInputElement).type==='password'))continue;
        const fieldNames=kind==='form'?fields(el).map(name):kind==='table'?Array.from(el.querySelectorAll('th')).filter(visible).slice(0,20).map(e=>text(rendered(e))):undefined;
        const label=(kind==='form'?text(el.getAttribute('aria-label')||el.getAttribute('name')||fieldNames?.join(' · ')):kind==='table'?text(el.querySelector('caption')?.textContent||fieldNames?.join(' · ')||'Tabulka'):name(el)||text((el as HTMLInputElement).value)) || kind;
        const id='e'+targets.length;
        const target:PageTarget={id,kind,name:label,fields:fieldNames,section:section(el)};
        if(kind==='file'){const file=el as HTMLInputElement;target.accept=file.accept.slice(0,300);target.multiple=file.multiple;target.disabled=file.disabled||!!file.closest('[inert],fieldset[disabled]');}
        if(el instanceof HTMLSelectElement){
          target.disabled=el.disabled||!!el.closest('[inert],fieldset[disabled]');
          target.options=[];
          for(const o of Array.from(el.options).slice(0,40)){
            if(o.value.length>2000)continue;
            const option={index:o.index,label:text(o.text),selected:o.selected,disabled:o.disabled||!!o.hidden||!!o.closest('optgroup[disabled],[hidden]'),placeholder:o.value===''};
            const size=JSON.stringify(option).length;if(size>optionBudget)break;
            target.options.push(option);optionBudget-=size;
          }
          target.optionsTruncated=target.options.length!==el.options.length;
        }
        if(kind==='link'){try{const url=new URL((el as HTMLAnchorElement).href);if(url.origin===location.origin)target.href=url.pathname+url.search;}catch{/* Not a navigable target. */}}
        if(el.hasAttribute('aria-expanded'))target.expanded=el.getAttribute('aria-expanded')==='true';
        if(kind==='link'||kind==='button'){
          const menu=el.closest('nav li,[role="menuitem"],.admin__menu li');
          // Collapsed menu labels are navigation hints, not rendered answer evidence
          // or executable targets. innerText is empty under visibility:hidden.
          if(menu){const labels=[...new Set(Array.from(menu.querySelectorAll('a,button,[role="menuitem"]')).filter(child=>child!==el).map(child=>text(child.getAttribute('aria-label')||child.textContent)).filter(Boolean))];if(labels.length){target.contains=labels.slice(0,24);target.containsTruncated=labels.length>24;}}
        }
        if(kind==='table'){
          const rows=Array.from(el.querySelectorAll('tr')).filter(visible);target.rowCount=rows.length;
          const preview=rows.slice(0,6).map(row=>Array.from(row.querySelectorAll('th,td')).filter(visible).slice(0,8).map(cell=>text(rendered(cell))));
          if(JSON.stringify(preview).length<=previewBudget){target.preview=preview;previewBudget-=JSON.stringify(preview).length;}
          target.previewTruncated=!target.preview||rows.length>6||rows.some(row=>Array.from(row.querySelectorAll('th,td')).filter(visible).length>8)||rows.slice(0,6).some(row=>Array.from(row.querySelectorAll('th,td')).filter(visible).some(c=>rendered(c).replace(/\s+/g,' ').trim().length>120));
        }
        targets.push(target);
        state.entries.set(id,{el,kind,fingerprint:fingerprint(el),optionIndices:target.options?.map(o=>o.index)});
        if(targets.length>=(input.kind==='all'||input.kind==='extract'?47:48))break;
      }
      if(['extract','all'].includes(input.kind)&&targets.length<48&&document.body&&visible(document.body)){
        const id='e'+targets.length;targets.push({id,kind:'text',name:'Obsah stránky'});state.entries.set(id,{el:document.body,kind:'text',fingerprint:fingerprint(document.body)});
      }
      const content=document.body?.innerText??'';
      const snapshot:Snapshot={documentToken:state.token,origin:location.origin,path:location.pathname,pageVersion:pageVersion(),dataVersion:dataVersion(),title:text(document.title),headings:Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]')).filter(visible).slice(0,12).map(h=>text(h.textContent)),text:content.slice(0,3200),truncated:content.length>3200||elements.length>targets.length,targets};
      return {ok:true,snapshot,limitations:{iframes:document.querySelectorAll('iframe').length,limit:48,truncated:snapshot.truncated}};
    }
    const state=world.__browserPilot,entry=state?.entries.get(input.targetId);
    if(!state||state.token!==input.token||location.origin!==input.origin||!entry)throw new Error('stale_snapshot');
    // A read deliberately observes the latest data inside the same live element.
    // Dynamic row/text updates must not make a document-bound read impossible.
    const check=()=>{assertReady(entry.el);if(world.__browserPilot!==state||location.origin!==input.origin||input.recipe!=='extract'&&fingerprint(entry.el)!==entry.fingerprint)throw new Error('stale_snapshot');};
    check();
    if(input.recipe==='extract') {
      if(entry.kind==='text'){
        const content=(entry.el as HTMLElement).innerText;state.entries.delete(input.targetId);return {ok:true,text:content.slice(0,16000),truncated:content.length>16000};
      }
      if(entry.kind!=='table')throw new Error('wrong_target_kind');
      const allRows=Array.from(entry.el.querySelectorAll('tr')).filter(visible);
      const rows=allRows.slice(0,101).map(row=>Array.from(row.querySelectorAll('th,td')).filter(visible).slice(0,30).map(cell=>text(rendered(cell))));
      const truncation={rows:allRows.length>101,columns:allRows.slice(0,101).some(row=>Array.from(row.querySelectorAll('th,td')).filter(visible).length>30),cells:allRows.slice(0,101).some(row=>Array.from(row.querySelectorAll('th,td')).filter(visible).slice(0,30).some(c=>rendered(c).replace(/\s+/g,' ').trim().length>120))};
      state.entries.delete(input.targetId);return {ok:true,rows,truncated:Object.values(truncation).some(Boolean),truncation,rowCount:allRows.length,section:section(entry.el)};
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
    if(entry.kind!=='form'&&(entry.kind!=='select'||input.recipe!=='fill'))throw new Error('wrong_target_kind');
    const available=fields(entry.el);
    let writes:{element:HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement;value:string}[]=[];
    if(input.selectOptionIndex!==undefined){
      if(input.recipe!=='fill'||input.fields||!(entry.el instanceof HTMLSelectElement)||!Number.isInteger(input.selectOptionIndex)||!entry.optionIndices?.includes(input.selectOptionIndex))throw new Error('invalid_option');
      const option=entry.el.options[input.selectOptionIndex];
      if(!option||option.disabled||option.hidden||option.closest('optgroup[disabled],[hidden]'))throw new Error('invalid_option');
      writes=[{element:entry.el,value:option.value}];
    }else if(input.recipe==='login') {
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
        if(matching.length!==1||(matching[0] as HTMLInputElement).type==='password'||matching[0]&&['current-password','new-password','one-time-code'].includes(matching[0].getAttribute('autocomplete')?.trim().split(/\s+/).at(-1)??'')||matching[0]?.closest('[data-private],[data-sensitive]'))throw new Error('ambiguous_field');
        writes.push({element:matching[0] as HTMLInputElement,value});
      }
    }
    for(const {element,value} of writes) {
      assertReady(element);if((element as HTMLInputElement).readOnly)throw new Error('field_readonly');
      if(element instanceof HTMLSelectElement&&!Array.from(element.options).some(o=>o.value===value&&!o.disabled&&!o.closest('optgroup[disabled]')))throw new Error('invalid_option');
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
