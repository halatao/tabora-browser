import test from 'node:test';
import assert from 'node:assert/strict';
import {McpConnection} from '../src/host/mcp-connection.js';
import {PilotError} from '../src/shared.js';

test('MCP reconnects on the next request and never replays a lost execution',async()=>{
  let opens=0,calls=0;
  const connection=new McpConnection(async()=>{
    opens++;
    const peer={onclose:()=>{},close(){peer.onclose();},async call(){calls++;if(calls===1)throw new PilotError('connection_lost');return {connected:true};}};return peer;
  });
  await assert.rejects(connection.call('tool',{name:'browser_execute'}),{message:'connection_lost'});
  assert.equal(opens,1);assert.equal(calls,1);
  assert.deepEqual(await connection.call('tool',{name:'browser_profiles'}),{connected:true});
  assert.equal(opens,2);assert.equal(calls,2);connection.close();
  await assert.rejects(connection.call('tool',{}),{message:'connection_lost'});
});

test('Concurrent requests share one connection; shutdown during auth closes it',async()=>{
  let opens=0,closed=0;
  let resolve!:(peer:any)=>void;
  const connection=new McpConnection(()=>{opens++;return new Promise(yes=>{resolve=yes;});});
  const first=connection.ready(),second=connection.ready();assert.equal(opens,1);
  connection.close();resolve({onclose:()=>{},close(){closed++;},async call(){assert.fail('Closed connection executed a request');}});
  await assert.rejects(first,{message:'connection_lost'});await assert.rejects(second,{message:'connection_lost'});assert.equal(closed,1);
});
