import test from 'node:test';
import assert from 'node:assert/strict';
import {readAll} from '../src/host/reader-service.js';
test('reader service rejects malformed offsets, partial scope and document/revision changes',async()=>{
  await assert.rejects(readAll(async()=>({nextOffset:undefined,provenance:{documentToken:'t'}}),{}),/reader_no_progress/);
  await assert.rejects(readAll(async()=>({nextOffset:null,complete:false,truncated:true,provenance:{documentToken:'t'}}),{}),/incomplete_dataset/);
  let i=0;await assert.rejects(readAll(async()=>({nextOffset:i++?null:1,complete:true,revision:i===1?'a':'b',provenance:{documentToken:'t'}}),{}),/reader_changed/);
});
