import test from 'node:test';
import assert from 'node:assert/strict';
import {clippedRedactions} from '../src/extension/capture-redaction.js';

const clip={x:20,y:80,width:200,height:160};
test('off-capture motion is irrelevant but entering the captured region changes redaction',()=>{
  assert.deepEqual(clippedRedactions([{x:800,y:600,width:100,height:20}],clip),[]);
  assert.deepEqual(clippedRedactions([{x:801,y:600,width:100,height:20}],clip),[]);
  assert.deepEqual(clippedRedactions([{x:210,y:90,width:100,height:20}],clip),[{x:210,y:90,width:10,height:20}]);
});
test('clip masks preserve fractional coverage and ignore zero area or edge contact',()=>{
  assert.deepEqual(clippedRedactions([{x:0,y:80.25,width:40.5,height:500}],clip),[{x:20,y:80.25,width:20.5,height:159.75}]);
  assert.deepEqual(clippedRedactions([{x:220,y:100,width:30,height:10},{x:40,y:100,width:0,height:10}],clip),[]);
  assert.deepEqual(clippedRedactions([{x:0,y:0,width:1000,height:1000}],clip),[clip]);
});
