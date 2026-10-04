import test from 'node:test';import assert from 'node:assert/strict';import {tableLayout} from '../src/table-layout.js';
test('row/column spans preserve multi-level headers and exact text',()=>{
  const result=tableLayout([[{text:'Record',rowSpan:2,header:true},{text:'Amounts',colSpan:2,header:true}],[{text:'Net',header:true},{text:'Tax',header:true}],[{text:'000123'},{text:'1 234,50'},{text:'20,00'}]]);
  assert.deepEqual(result.headers,['Record','Amounts / Net','Amounts / Tax']);assert.equal(result.headerRows,2);assert.equal(result.complete,true);assert.equal(result.rows[2][0],'000123');
});
test('sparse grids and conflicting spans are explicit',()=>{
  assert.equal(tableLayout([[{text:'A',column:0},{text:'C',column:2}]]).complete,false);
  assert.throws(()=>tableLayout([[{text:'A',rowSpan:2}],[{text:'B',column:0}]]),/overlapping/);
  assert.throws(()=>tableLayout([[{text:'A',rowSpan:2}]]),/incomplete/);
});
