/** Exact decimal arithmetic with an explicit display locale; never rounds identifiers through Number. */
export function decimalAggregate(cells:string[],operation:'sum'|'min'|'max'|'count',decimal:'.'|',',group:string){
  if(operation==='count')return {value:String(cells.length),indices:[] as number[]};
  if(decimal===group)throw new Error('invalid_numeric_locale');
  const parsed=cells.map(cell=>{
    if(cell.length>120)throw new Error('invalid_numeric_cell');
    let value=cell.trim().replace(/^[$€£]\s*|\s*[$€£]$/g,'');
    if(group){
      const integer=value.replace(/^[+-]/,'').split(decimal)[0];
      if(integer.includes(group)&&!new RegExp('^\\d{1,3}(?:'+group.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\d{3})+$').test(integer))throw new Error('invalid_numeric_cell');
      if(value.slice(value.indexOf(decimal)+1).includes(group)&&value.includes(decimal))throw new Error('invalid_numeric_cell');
      value=value.split(group).join('');
    }
    if(decimal===',')value=value.replace(',','.');
    if(!/^[+-]?\d+(?:\.\d{1,20})?$/.test(value))throw new Error('invalid_numeric_cell');
    const [whole,fraction='']=value.replace(/^[+-]/,'').split('.');return {units:BigInt(whole+fraction)*(value.startsWith('-')?-1n:1n),scale:fraction.length};
  });
  if(!parsed.length&&operation!=='sum')throw new Error('empty_dataset');
  const scale=Math.max(0,...parsed.map(value=>value.scale)),values=parsed.map(value=>value.units*10n**BigInt(scale-value.scale));
  const result=operation==='sum'?values.reduce((sum,value)=>sum+value,0n):values.reduce((previous,value)=>operation==='max'?(value>previous?value:previous):(value<previous?value:previous));
  const digits=(result<0n?-result:result).toString().padStart(scale+1,'0');
  return {value:(result<0n?'-':'')+(scale?digits.slice(0,-scale)+'.'+digits.slice(-scale):digits),indices:operation==='sum'?[]:values.flatMap((value,index)=>value===result?[index]:[])};
}
