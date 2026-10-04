import {Worker} from 'node:worker_threads';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
const fixtures=path.resolve('../browser-capability-bench'),worker=path.resolve('dist/host/document-worker.js');
const generate=(variant)=>new Uint8Array(execFileSync('python',['-c','from document_fixtures import pdf;import sys;sys.stdout.buffer.write(pdf("00012345678901234567890",int(sys.argv[1])))',String(variant)],{cwd:fixtures,windowsHide:true}));
async function read(bytes,options={}){
  const instance=new Worker(worker,{workerData:{bytes,format:'pdf',page:2,ocr:false,layout:false,offset:0,limit:16000,...options},stdout:true,stderr:true});instance.stdout.resume();instance.stderr.resume();
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{void instance.terminate();reject(Error('document timeout'));},35000);instance.once('message',result=>{clearTimeout(timer);void instance.terminate();resolve(result);});instance.once('error',error=>{clearTimeout(timer);reject(error);});});
}
const text=await read(generate(1),{layout:true});assert(text.ok);assert.equal(text.result.pageCount,2);assert(text.result.text.includes('00012345678901234567890'));assert(text.result.layout.items.length);assert.equal(text.result.layout.precision,'pdf_positions_not_inferred_table');
const scan=await read(generate(2));assert(scan.ok);assert.equal(scan.result.needsOCR,true);assert.equal(scan.result.text,'');
const ocr=await read(generate(2),{ocr:true});assert(ocr.ok,JSON.stringify(ocr));assert.equal(ocr.result.precision,'ocr_estimated');assert(ocr.result.text.replace(/\s/g,'').includes('00012345678901234567890'),JSON.stringify(ocr));
const table=await read(generate(3),{layout:true});assert(table.ok);assert(table.result.text.includes('3580.10'));assert(table.result.layout.items.some(item=>item.text.includes('TOTAL')));
const locked=await read(generate(4));assert.equal(locked.ok,false);assert.equal(locked.code,'document_password_required');
const invalid=await read(new Uint8Array([0,1,2]));assert.equal(invalid.code,'invalid_pdf');
console.log('PASS: actual multi-page text PDF, scanned PDF detection/offline OCR, glyph layout/table text, protected PDF handoff and invalid-document rejection.');
