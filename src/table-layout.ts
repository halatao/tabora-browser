export type TableCell={text:string;colSpan?:number;rowSpan?:number;column?:number;header?:boolean};
/** Expand only observed cells. Missing/overlapping coordinates are never silently invented. */
export function tableLayout(source:TableCell[][]){
  if(source.length>5000)throw new Error('table_size_limit');
  const rows:string[][]=[],headers:string[][]=[];let slots=0,headerRows=0;
  for(let r=0;r<source.length;r++){
    rows[r]??=[];headers[r]??=[];let cursor=0;
    for(const cell of source[r]){
      while(rows[r][cursor]!==undefined)cursor++;
      const c=cell.column===undefined?cursor:cell.column;
      const width=cell.colSpan??1,height=cell.rowSpan===0?source.length-r:cell.rowSpan??1;
      if(!Number.isInteger(c)||c<0||!Number.isInteger(width)||width<1||width>256||!Number.isInteger(height)||height<1||height>5000||c+width>256||r+height>source.length)throw new Error('incomplete_table_layout');
      if(cell.text.length>1000000)throw new Error('reader_size_limit');
      for(let y=r;y<r+height;y++)for(let x=c;x<c+width;x++){
        rows[y]??=[];headers[y]??=[];
        if(rows[y][x]!==undefined)throw new Error('overlapping_table_cells');
        if(++slots>100000)throw new Error('table_size_limit');
        rows[y][x]=cell.text;headers[y][x]=cell.header?cell.text:'';
      }
      cursor=c+width;
    }
    if(r===headerRows&&source[r].length&&source[r].every(cell=>cell.header))headerRows++;
  }
  const width=Math.max(0,...rows.map(row=>row.length));
  const columnHeaders=Array.from({length:width},(_,c)=>[...new Set(headers.slice(0,headerRows).map(row=>row[c]).filter(Boolean))].join(' / '));
  return {rows,headers:columnHeaders,headerRows,columnCount:width,complete:rows.every(row=>row.length===width&&Array.from({length:width},(_,c)=>row[c]).every(value=>value!==undefined))};
}
