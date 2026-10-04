import type {ObservationV2,TargetV2} from '../capabilities.js';
import {ancestor,accessibleName,content,role,composedElements} from './semantic.js';
import type {RecordCollection} from '../record-collection.js';
import {ownedCombobox} from './widgets.js';
export type RegistryEntry={el:Element;fingerprint:string;target:TargetV2};
export class Registry{
  readonly token=crypto.randomUUID();
  readonly entries=new Map<string,RegistryEntry>();
  private ids=new WeakMap<Element,string>();
  private nextId=0;
  epoch=0;
  snapshots=new Map<string,ObservationV2>();
  private sequences=new Map<string,string>();
  private observers=new Map<Node,MutationObserver>();
  private roots=new WeakSet<Node>();
  private options=new Map<string,Map<number,string>>();
  readonly collections=new Map<string,RecordCollection>();
  private treeEpoch=0;
  private scanCache?:{epoch:number;time:number;result:ReturnType<typeof composedElements>};
  private metadata=new WeakMap<Element,{epoch:number;key:string;expires:number;value:Omit<TargetV2,'id'>}>();
  private events:((event:Event)=>void)|undefined;
  private changed(records:MutationRecord[]){if(records.length)this.epoch++;if(records.some(record=>record.type==='childList'))this.treeEpoch++;}
  scan(fresh=false){
    if(fresh){this.scanCache=undefined;this.metadata=new WeakMap();}
    for(const [root,observer] of this.observers){if(!root.isConnected){observer.disconnect();this.observers.delete(root);this.roots.delete(root);}else this.changed(observer.takeRecords());}
    const now=performance.now(),hit=this.scanCache?.epoch===this.treeEpoch&&now-this.scanCache.time<1000;
    if(!hit)this.scanCache={epoch:this.treeEpoch,time:now,result:composedElements(document,20000)};
    for(const el of this.scanCache!.result.elements){const root=el.getRootNode();if(root instanceof ShadowRoot)this.watch(root);}
    return {...this.scanCache!.result,cached:hit};
  }
  describe(el:Element,describe:(el:Element)=>Omit<TargetV2,'id'>){
    const field=el as HTMLInputElement,sensitive=el.matches('input[type="password"],input[type="file"],[autocomplete="current-password"],[autocomplete="new-password"],[autocomplete~="one-time-code"]')||!!ancestor(el,'[data-private],[data-sensitive]'),key=JSON.stringify([innerWidth,innerHeight,scrollX,scrollY,el.scrollLeft,el.scrollTop,sensitive?undefined:field.value,field.checked,field.indeterminate,field.disabled,field.readOnly,el instanceof HTMLSelectElement?Array.from(el.selectedOptions).map(option=>option.index):undefined]),cached=this.metadata.get(el);
    if(cached?.epoch===this.epoch&&cached.key===key&&cached.expires>performance.now())return {value:cached.value,cached:true};
    const value=describe(el);this.metadata.set(el,{epoch:this.epoch,key,expires:performance.now()+250,value});return {value,cached:false};
  }
  watch(root:Node){
    if(this.roots.has(root))return;this.roots.add(root);
    if(this.observers.size>=1000){this.roots.delete(root);throw new Error('shadow_root_limit');}
    const observer=new MutationObserver(records=>this.changed(records));
    observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true});this.observers.set(root,observer);
    if(!this.events){this.events=event=>{this.epoch++;if(event.isTrusted&&['input','change','pointerdown','keydown'].includes(event.type))this.snapshots.clear();};for(const event of ['input','change','toggle','pointerover','pointerout','pointerdown','keydown','slotchange'])document.addEventListener(event,this.events,true);}
  }
  register(el:Element,target:Omit<TargetV2,'id'>):TargetV2{
    const id=this.reference(el);
    const value={...target,id};this.entries.set(id,{el,target:value,fingerprint:this.fingerprint(el)});
    if(el instanceof HTMLSelectElement)this.observeOptions(id,(target.options??[]).map(option=>option.index));return value;
  }
  reference(el:Element){let id=this.ids.get(el);if(!id){id='r'+this.nextId++;this.ids.set(el,id);}return id;}
  observeOptions(id:string,indices:number[]){const el=this.resolve(id).el;if(!(el instanceof HTMLSelectElement))throw new Error('wrong_target_kind');const observed=this.options.get(id)??new Map<number,string>();for(const index of indices){if(observed.size>=1000&&!observed.has(index))throw new Error('option_limit');const option=el.options[index];if(option)observed.set(index,JSON.stringify([option.text,option.value,option.disabled]));}this.options.set(id,observed);}
  validateOptions(id:string,indices:number[]){const el=this.resolve(id).el;if(!(el instanceof HTMLSelectElement))throw new Error('wrong_target_kind');for(const index of indices){const option=el.options[index];if(!option||this.options.get(id)?.get(index)!==JSON.stringify([option.text,option.value,option.disabled]))throw new Error('unobserved_option');}}
  fingerprint(el:Element):string{
    const record=ancestor(el,'[data-id],[data-key],[aria-rowindex]');
    const widget=ownedCombobox(el);
    return JSON.stringify([el.tagName,role(el),accessibleName(el),el.getAttribute('href'),el.getAttribute('type'),el.getAttribute('autocomplete'),!!ancestor(el,'[data-private],[data-sensitive]'),el.getAttribute('data-id'),el.getAttribute('data-key'),el.getAttribute('aria-rowindex'),ancestor(el,'[data-id],[data-key],[aria-rowindex]')?.getAttribute('data-id'),
      widget?[this.reference(widget),accessibleName(widget),widget.getAttribute('aria-controls'),widget.disabled,widget.getAttribute('aria-disabled')]:undefined,
      record?[record.getAttribute('data-id'),record.getAttribute('data-key'),record.getAttribute('aria-rowindex'),content(record,4000)]:undefined,
      el.matches('[role="row"],tr,[role="option"],[role="treeitem"]')?content(el,4000):undefined]);
  }
  resolve(id:string,write=false):RegistryEntry{
    const entry=this.entries.get(id);if(!entry||!entry.el.isConnected)throw new Error('stale_reference');
    if(write&&entry.fingerprint!==this.fingerprint(entry.el))throw new Error('stale_reference');
    return entry;
  }
  prune(){const retained=new Set([...this.snapshots.values()].flatMap(snapshot=>snapshot.targets.map(target=>target.id)));for(const [id,entry] of this.entries)if(!entry.el.isConnected||this.entries.size>10000&&!retained.has(id)){this.entries.delete(id);this.options.delete(id);this.collections.delete(id);}}
  save(snapshot:ObservationV2,sequence?:string){
    const previous=[...this.snapshots.values()].at(-1);let continuationOf:string|undefined;
    if(snapshot.coverage.cursor>0){
      if(!previous||previous.coverage.nextCursor!==snapshot.coverage.cursor||sequence===undefined||this.sequences.get(previous.snapshotId)!==sequence)throw new Error('stale_continuation');
      for(const target of previous.targets)this.resolve(target.id,true);
      continuationOf=previous.snapshotId;const targets=[...previous.targets,...snapshot.targets];if(targets.length>20000)throw new Error('target_limit');
      this.snapshots.set(snapshot.snapshotId,{...snapshot,targets});
    }else this.snapshots.set(snapshot.snapshotId,snapshot);
    if(sequence!==undefined)this.sequences.set(snapshot.snapshotId,sequence);while(this.snapshots.size>3){const first=this.snapshots.keys().next().value!;this.snapshots.delete(first);this.sequences.delete(first);}for(const id of this.sequences.keys())if(!this.snapshots.has(id))this.sequences.delete(id);return continuationOf;
  }
  close(){this.observers.forEach(o=>o.disconnect());this.observers.clear();if(this.events)for(const event of ['input','change','toggle','pointerover','pointerout','pointerdown','keydown','slotchange'])document.removeEventListener(event,this.events,true);this.events=undefined;this.entries.clear();this.snapshots.clear();this.sequences.clear();this.options.clear();this.collections.clear();this.scanCache=undefined;}
}
