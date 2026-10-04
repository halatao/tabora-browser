import test from 'node:test';import assert from 'node:assert/strict';import {createCanvas,loadImage} from '@napi-rs/canvas';import {redactImage} from '../src/host/image-redaction.js';
test('pixel redaction masks sensitive pixels including fractional/scaled bounds',async()=>{
  const canvas=createCanvas(100,100),context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,100,100);
  const result=await redactImage(canvas.toBuffer('image/png'),{width:50,height:50,masks:[{x:10.2,y:10.2,width:10,height:10}]});
  context.drawImage(await loadImage(result),0,0);assert.deepEqual(Array.from(context.getImageData(21,21,1,1).data),[0,0,0,255]);assert.deepEqual(Array.from(context.getImageData(5,5,1,1).data),[255,255,255,255]);
  await assert.rejects(redactImage(result,{width:50,height:50,masks:[{x:NaN,y:0,width:10,height:10}]}),/capture_redaction_failed/);
});
