import test from 'node:test';
import assert from 'node:assert/strict';
import {RunController} from '../src/host/run-controller.js';
import {workflowSchema} from '../src/browser-api.js';
import {PilotError} from '../src/shared.js';

test('run entry points report the actual engine and planning contract, including failed runs',async()=>{
  const controller=new RunController();
  const variants=[
    {session:'retrieval',options:{},expected:{engine:'workflow-v2',contractVersion:2,goalPlanning:'grounded-goal'}},
    {session:'task',options:{task:true},expected:{engine:'workflow-v2',contractVersion:2,goalPlanning:'grounded-goal'}},
    {session:'workflow',options:{task:true,workflow:workflowSchema.parse({success:{name:'Receipt',contains:'Saved'}})},expected:{engine:'workflow-v2',contractVersion:2,goalPlanning:'caller-workflow'}},
  ];
  for(const variant of variants){
    const run=controller.start('owner','profile',variant.session,'typesafe-jev','Do the task',async()=>{throw new PilotError('fixture_disconnected');},{maxSteps:1,timeoutMs:1000,readonly:true,...variant.options});
    assert.deepEqual(run.execution,variant.expected);
    run.execution.goalPlanning='caller-workflow'; // Returned diagnostic data must not mutate host state.
    await new Promise<void>(resolve=>setImmediate(resolve));
    const terminal=controller.status('owner',run.id);
    assert.equal(terminal.status,'failed');
    assert.deepEqual(terminal.execution,variant.expected);
    assert.throws(()=>controller.status('another-owner',run.id),/run_not_owned/);
  }
});
