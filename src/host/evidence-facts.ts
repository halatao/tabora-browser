import {decimalAggregate} from '../decimal.js';
import type {Snapshot,Binding} from '../shared.js';
function numeric(value:string){try{decimalAggregate([value],'sum','.',',');return true;}catch{return false;}}
function compare(a:string,b:string){const maximum=decimalAggregate([a,b],'max','.',',');return maximum.indices.length===2?0:maximum.indices[0]===0?1:-1;}
export type Evidence={origin:string;path:string;documentId:string;documentToken:string;targetId?:string;section?:string;description:string;complete:boolean};
export type Fact={value:string;values?:string[];evidence:Evidence};
type Read={targetId:string;name:string;section?:string;rows?:string[][];text?:string;truncated:boolean};
/** Candidate answers are grounded in the current observation/read, never another model. */
export function answerFacts(snapshot:Snapshot,binding:Binding,read?:Read):Fact[]{
  const facts:Fact[]=[];
  const add=(value:string,description:string,targetId?:string,section?:string,complete=true)=>{
    if(!value||value.length>500)return;
    if(/^[$€£]\s*-?\d[\d,]*(?:\.\d+)?$/.test(value)){const displayed=value;try{value=decimalAggregate([value],'sum','.',',').value.replace(/(\.\d*?[1-9])0+$|\.0+$/,'$1');}catch{return;}description=`${description} (displayed ${displayed})`;}
    facts.push({value,evidence:{origin:snapshot.origin,path:snapshot.path,documentId:binding.documentId,documentToken:snapshot.documentToken,targetId,section,description:description.slice(0,240),complete}});
  };
  const content=read?.text??snapshot.text??'';
  for(const line of content.split(/\n/).map(s=>s.trim()).filter(Boolean)){
    const count=line.match(/^(\d+)\s+(?:items?|records?|results?|reviews?)(?:\s|$)/i);
    if(count)add(count[1],`Explicit total count on ${snapshot.title??snapshot.path}: ${line}`,read?.targetId,read?.section??snapshot.title,true);
    const labeled=line.match(/^(.{2,100}?)\s*[:\t]\s*([$€£]?\s*-?\d[\d,.]*)(?:\s|$)/);
    if(labeled)add(labeled[2].trim(),`${labeled[1]}: ${labeled[2]}`,read?.targetId,read?.section??snapshot.title,true);
  }
  const tables=read?.rows?[{id:read.targetId,name:read.name,section:read.section,preview:read.rows,previewTruncated:read.truncated}]:snapshot.targets.filter(t=>t.kind==='table');
  for(const table of tables){
    const rows=table.preview??[],header=rows[0]??[],data=rows.slice(1),label=table.section??table.name,complete=!table.previewTruncated;
    if(complete&&data.length){
      for(let col=0;col<header.length;col++){
        if(data.every(row=>/^[$€£]?\s*-?\d[\d,.]*\s*$/.test(row[col]??''))){
          let aggregate;try{aggregate=decimalAggregate(data.map(row=>row[col]??''),'max','.',',');}catch{continue;}
          const max=aggregate.value,winners=aggregate.indices.map(index=>data[index]);
          if(winners.length===1&&winners[0][0])add(winners[0][0],`${label}: highest ${header[col]} = ${max}; record ${winners[0].join(' | ')}; all ${data.length} rows read`,table.id,label,true);
        }
      }
    }
    for(let row=1;row<Math.min(rows.length,51);row++)for(let col=0;col<Math.min(rows[row].length,12);col++)add(rows[row][col],`${label}: ${header[col]??'value'}; row ${rows[row].join(' | ')}`,table.id,label,complete);
  }
  return facts;
}
/** Bounded projections of complete observed tables; the provider selects the
 * appropriate column/ranking/filter, without generating answer values. */
export function listAnswerFacts(goal:string,snapshot:Snapshot,binding:Binding,read?:Read):Fact[]{
  const match=goal.match(/\b(?:top|first|last)\s+(\d{1,2})\b/i);
  const count=match?Number(match[1]):undefined;
  const all=/\b(?:list|all)\b/i.test(goal);
  if(!count&&!all||count!==undefined&&(count<1||count>20))return [];
  const tables=read?.rows?[{id:read.targetId,name:read.name,section:read.section,preview:read.rows,previewTruncated:read.truncated}]:snapshot.targets.filter(t=>t.kind==='table');
  const facts:Fact[]=[];
  for(const table of tables){
    if(table.previewTruncated)continue;
    const rows=table.preview??[],header=rows[0]??[],data=rows.slice(1);
    if(!data.length||data.length>50||data.some(row=>row.length!==header.length))continue;
    const size=count??data.length;
    const add=(ordered:string[][],column:number,operation:string)=>{
      if(ordered.length<size)return;
      const values=ordered.slice(0,size).map(row=>row[column]);
      if(values.some(value=>!value||value.length>500)||JSON.stringify(values).length>3000)return;
      const description=`${table.section??table.name}: ${header[column]}; ${operation}; ${size} values from complete observed table`;
      facts.push({value:JSON.stringify(values),values,evidence:{origin:snapshot.origin,path:snapshot.path,documentId:binding.documentId,documentToken:snapshot.documentToken,targetId:table.id,section:table.section??table.name,description:description.slice(0,240),complete:true}});
    };
    for(let column=0;column<Math.min(header.length,12);column++){
      if(!match||match[0].toLowerCase().startsWith('first')||/\btop\b/i.test(table.section??table.name))add(data,column,'displayed row order');
      if(match?.[0].toLowerCase().startsWith('last'))add([...data].reverse(),column,'reverse displayed row order');
      if(match?.[0].toLowerCase().startsWith('top')&&/\btop\b/i.test(table.section??table.name))for(let filter=0;filter<header.length;filter++){
        if(filter!==column&&data.every(row=>numeric(row[filter])))add(data.filter(row=>compare(row[filter],'0')>0),column,`displayed rank order, only rows with ${header[filter]} > 0`);
      }
      if(match?.[0].toLowerCase().startsWith('top')&&!/\btop\b/i.test(table.section??table.name))for(let rank=0;rank<header.length;rank++){
        if(rank===column||!data.every(row=>numeric(row[rank])))continue;
        const ordered=[...data].sort((a,b)=>compare(b[rank],a[rank]));
        // An unresolved tie across the cutoff cannot prove a unique top-N.
        if(ordered.length>size&&compare(ordered[size-1][rank],ordered[size][rank])===0)continue;
        add(ordered,column,`descending ${header[rank]}`);
        for(let filter=0;filter<header.length;filter++){
          if(filter===column||!data.every(row=>numeric(row[filter])))continue;
          const filtered=ordered.filter(row=>compare(row[filter],'0')>0);
          if(filtered.length>size&&compare(filtered[size-1][rank],filtered[size][rank])===0)continue;
          add(filtered,column,`descending ${header[rank]}, only rows with ${header[filter]} > 0`);
        }
      }
    }
  }
  return facts;
}
export function relevantFacts(goal:string,facts:Fact[]):Fact[]{
  const generic=new Set(['get','find','return','value','number','count','total','grand','top','most','store','amongst','only','without','any','additional','details','the','and','for','with','from','how','many','what','all','my','that','this','počet','zjisti','najdi','vrat']);
  const stem=(word:string)=>word.length>4&&word.endsWith('s')?word.slice(0,-1):word;
  const subjects=goal.toLowerCase().match(/[\p{L}]{3,}/gu)?.filter(word=>!generic.has(word)).map(stem)??[];
  const identifiers=goal.match(/\b0\d{3,}\b/g)??[];
  return facts.filter(f=>{
    const evidence=(f.evidence.section??'')+' '+f.evidence.description;
    const words=(evidence.toLowerCase().match(/[\p{L}]{3,}/gu)??[]).map(stem);
    return (!subjects.length||subjects.some(word=>words.includes(word)))&&identifiers.every(id=>evidence.includes(id));
  });
}
