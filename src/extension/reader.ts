import type {ReaderResult} from '../capabilities.js';
import {Registry} from './registry.js';
import {content,visible,composedElements,ancestor,parentElement} from './semantic.js';
import {decimalAggregate} from '../decimal.js';
import {tableLayout} from '../table-layout.js';
import {collectRecords} from '../record-collection.js';
import {editorText} from './editor.js';

export type ReadInput={targetId:string;format:'text'|'rows'|'options'|'chart'|'aggregate'|'records';offset:number;limit:number;revision?:string;row?:number;column?:number;labelColumn?:number;operation?:'sum'|'min'|'max'|'count';decimal?:'.'|',';group?:string;skipHeader?:boolean;collect?:boolean;resetCollection?:boolean};
export function reader(registry:Registry,input:ReadInput):ReaderResult&{revision:string;headers?:string[];options?:unknown[];chart?:unknown;aggregate?:unknown;records?:unknown[]}{
  const entry=registry.resolve(input.targetId);let el=entry.el;
  if(ancestor(el,'[data-private],[data-sensitive]')||entry.target.secret)throw new Error('data_not_exportable');
  let associatedTable=false;
  if(['aggregate','rows'].includes(input.format)&&el.matches('svg,canvas,img,[role="img"]')){
    const root=el.getRootNode() as Document|ShadowRoot,ids=(el.getAttribute('aria-details')??'').trim().split(/\s+/).filter(Boolean);
    const matches=ids.map(id=>root.getElementById(id)).filter((node):node is HTMLElement=>!!node&&node.matches('table,[role="table"],[role="grid"]')&&visible(node));
    if(matches.length!==1)throw new Error('chart_requires_structured_source');el=matches[0];associatedTable=true;
    if(ancestor(el,'[data-private],[data-sensitive]'))throw new Error('data_not_exportable');
  }
  const provenance={source:'page' as const,trust:'untrusted' as const,documentToken:registry.token,targetId:input.targetId,origin:location.origin,path:location.pathname};
  const base={schemaVersion:2 as const,offset:input.offset,provenance};
  const exact=(node:Element,max=1000000)=>{const value=(node instanceof HTMLElement&&node.isContentEditable?editorText(node):content(node,max+1)).replace(/\r\n/g,'\n');if(value.length>max)throw new Error('reader_size_limit');return value;};
  const fingerprint=(value:string)=>{let hash=2166136261;for(let i=0;i<value.length;i++)hash=Math.imul(hash^value.charCodeAt(i),16777619);return String(hash>>>0);};
  const checkRevision=(revision:string)=>{if(input.revision&&input.revision!==revision)throw new Error('reader_changed');};
  if(input.format==='records'){
    const scan=composedElements(el),candidates=scan.elements.filter(node=>node!==el&&node.matches('[role="row"],[role="listitem"],[data-id],[data-key]')&&visible(node)&&!ancestor(node,'[data-private],[data-sensitive]'));
    const candidateSet=new Set(candidates);let recordBudget=1000000;let records=candidates.filter(node=>{for(let parent=parentElement(node);parent&&parent!==el;parent=parentElement(parent))if(candidateSet.has(parent))return false;return true;}).map(node=>{const record={key:node.getAttribute('data-id')??node.getAttribute('data-key'),index:node.getAttribute('aria-rowindex')??node.getAttribute('aria-posinset'),text:exact(node,16000),fields:[] as {name:string;value:string}[]};let budget=16000-JSON.stringify(record).length;for(const field of composedElements(node).elements.filter(field=>field.matches('[data-field],dt,[role="cell"],[role="gridcell"]'))){const value={name:field.getAttribute('data-field')??field.getAttribute('aria-label')??(field.matches('dt')?exact(field,500):''),value:field.matches('dt')&&field.nextElementSibling?.matches('dd')?exact(field.nextElementSibling,16000):exact(field,16000)};budget-=JSON.stringify(value).length;if(budget<0)throw new Error('record_exceeds_budget');record.fields.push(value);}recordBudget-=JSON.stringify(record).length;if(recordBudget<0)throw new Error('reader_size_limit');return record;});
    const keys=records.map(record=>record.key).filter(Boolean),duplicateKeys=keys.length!==new Set(keys).size,total=Number(el.getAttribute('aria-rowcount')??el.getAttribute('aria-setsize'));
    if(input.collect){
      if(scan.truncated||duplicateKeys||!Number.isInteger(total)||total<1||total>2000||records.some(record=>!record.key||!record.index))throw new Error('collection_identity_required');
      const previous=input.resetCollection?undefined:registry.collections.get(input.targetId);if(!previous&&registry.collections.size>=10&&!registry.collections.has(input.targetId))throw new Error('collection_limit');
      const collection=collectRecords(previous,records,total);registry.collections.set(input.targetId,collection);records=[...collection.records.values()].sort((a,b)=>Number(a.index)-Number(b.index));
    }
    const revision=fingerprint(JSON.stringify(records));checkRevision(revision);const page:typeof records=[];let budget=16000;
    for(const record of records.slice(input.offset,input.offset+Math.min(input.limit,100))){const size=JSON.stringify(record).length;if(size>budget){if(!page.length)throw new Error('record_exceeds_budget');break;}page.push(record);budget-=size;}
    const end=input.offset+page.length,complete=end>=records.length&&!scan.truncated&&!duplicateKeys&&(!total||total===records.length);
    return {...base,revision,records:page,observedRows:records.length,totalRows:total||records.length,nextOffset:end<records.length?end:null,complete,truncated:!complete,coverage:{scope:input.collect?'collected_declared_records':'loaded_records',duplicateKeys,declaredTotal:total||null}} as ReturnType<typeof reader>;
  }
  if(input.format==='options'){
    if(!(el instanceof HTMLSelectElement))throw new Error('wrong_target_kind');
    if(el.options.length>5000)throw new Error('option_limit');
    const all=Array.from(el.options).map(o=>({index:o.index,label:o.text,selected:o.selected,disabled:o.disabled||!!o.closest('optgroup[disabled]')}));
    const revision=fingerprint(JSON.stringify(all));checkRevision(revision);
    const options:typeof all=[];let budget=16000;
    for(const option of all.slice(input.offset,input.offset+Math.min(input.limit,100))){const size=JSON.stringify(option).length;if(size>budget){if(!options.length)throw new Error('option_exceeds_budget');break;}options.push(option);budget-=size;}
    const end=input.offset+options.length;
    registry.observeOptions(input.targetId,options.map(option=>option.index));
    return {...base,revision,options,nextOffset:end<all.length?end:null,complete:end>=all.length,truncated:end<all.length};
  }
  const scan=el.matches('table,[role="table"],[role="grid"]')?composedElements(el):{elements:[],truncated:false};
  const rows=scan.elements.filter(row=>row!==el&&row.matches('tr,[role="row"]')&&visible(row));
  const cells=(row:Element)=>composedElements(row).elements.filter(cell=>cell!==row&&cell.matches('th,td,[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]')&&ancestor(cell,'tr,[role="row"]')===row);
  if(input.format==='rows'||input.format==='aggregate'){
    if(!el.matches('table,[role="table"],[role="grid"]'))throw new Error('wrong_target_kind');
    let tableBudget=1000000;const cellText=(cell:Element)=>{const value=exact(cell,16000);tableBudget-=value.length;if(tableBudget<0)throw new Error('reader_size_limit');return value;};
    const layout=tableLayout(rows.map(row=>cells(row).map(cell=>({text:cellText(cell),header:cell.matches('th,[role="columnheader"]'),colSpan:Number(cell.getAttribute('colspan')??cell.getAttribute('aria-colspan')??1),rowSpan:Number(cell.getAttribute('rowspan')??cell.getAttribute('aria-rowspan')??1),column:cell.hasAttribute('aria-colindex')?Number(cell.getAttribute('aria-colindex'))-1:undefined}))));
    const data=layout.rows;
    const revision=fingerprint(JSON.stringify(data));checkRevision(revision);
    const page:string[][]=[];let budget=16000;
    for(const row of data.slice(input.offset,input.offset+Math.min(input.limit,100))){const size=JSON.stringify(row).length;if(size>budget){if(!page.length)throw new Error('row_exceeds_budget');break;}page.push(row);budget-=size;}
    const total=Number(el.getAttribute('aria-rowcount')),virtualized=el.hasAttribute('aria-rowcount')&&total>data.length;
    const end=input.offset+page.length,complete=end>=data.length&&!virtualized&&!scan.truncated&&layout.complete;
    if(input.format==='aggregate'){
      if(virtualized||scan.truncated||!layout.complete)throw new Error('incomplete_dataset');
      if(input.column===undefined||!input.operation||!input.decimal||input.group===undefined)throw new Error('numeric_format_required');
      const records=data.slice(input.skipHeader===false?0:layout.headerRows),aggregate=decimalAggregate(records.map(row=>row[input.column!]??''),input.operation,input.decimal,input.group);
      let labels:string[]|undefined;
      if(input.labelColumn!==undefined){if(!['min','max'].includes(input.operation)||records.some(row=>row[input.labelColumn!]===undefined))throw new Error('invalid_label_column');labels=aggregate.indices.map(index=>records[index][input.labelColumn!]);if(JSON.stringify(labels).length>16000)throw new Error('reader_size_limit');}
      return {...base,revision,aggregate:{...aggregate,labels,exact:true,rowCount:records.length,column:input.column,source:associatedTable?'explicit_chart_data_table':'rendered_table'},nextOffset:null,complete:true,truncated:false};
    }
    return {...base,revision,rows:page,headerRows:layout.headerRows,headers:layout.headers,records:rows.slice(input.offset,end).map(row=>({key:row.getAttribute('data-id')??row.getAttribute('data-key'),index:row.getAttribute('aria-rowindex')})),observedRows:data.length,totalRows:total>0?total:data.length,nextOffset:end<data.length?end:null,complete,truncated:!complete,coverage:{scope:'rendered_table',declaredTotal:total>0?total:null}} as ReturnType<typeof reader>;
  }
  if(input.format==='chart'){
    if(!el.matches('svg,canvas,img,[role="img"]'))throw new Error('wrong_target_kind');
    let budget=16000;const labels=Array.from(el.querySelectorAll('title,desc,text')).map(node=>{const value=exact(node,16000);budget-=value.length;if(budget<0)throw new Error('reader_size_limit');return value;});
    const chart={description:el.getAttribute('aria-label')??el.getAttribute('alt')??'',labels,precision:'structured_labels_only',requiresVision:!labels.length};
    const revision=fingerprint(JSON.stringify(chart));checkRevision(revision);
    return {...base,revision,chart,nextOffset:null,complete:!!labels.length,truncated:!labels.length};
  }
  let value=(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement)&&el.type!=='file'?el.value:exact(el);if(value.length>1000000)throw new Error('reader_size_limit');
  if(input.row!==undefined||input.column!==undefined){
    if(input.row===undefined||input.column===undefined)throw new Error('invalid_cell_range');
    let budget=1000000;const text=(cell:Element)=>{const value=exact(cell,16000);budget-=value.length;if(budget<0)throw new Error('reader_size_limit');return value;};
    const layout=tableLayout(rows.map(row=>cells(row).map(cell=>({text:text(cell),header:cell.matches('th,[role="columnheader"]'),colSpan:Number(cell.getAttribute('colspan')??cell.getAttribute('aria-colspan')??1),rowSpan:Number(cell.getAttribute('rowspan')??cell.getAttribute('aria-rowspan')??1),column:cell.hasAttribute('aria-colindex')?Number(cell.getAttribute('aria-colindex'))-1:undefined}))));
    const cell=layout.rows[input.row]?.[input.column];if(cell===undefined)throw new Error('invalid_cell_range');value=cell;
  }
  const revision=fingerprint(value);checkRevision(revision);
  const text=value.slice(input.offset,input.offset+Math.min(input.limit,16000)),end=input.offset+text.length;
  return {...base,revision,text,nextOffset:end<value.length?end:null,complete:end>=value.length,truncated:end<value.length};
}
