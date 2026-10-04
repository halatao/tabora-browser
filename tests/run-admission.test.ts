import test from 'node:test';
import assert from 'node:assert/strict';
import {admitRun} from '../src/host/run-admission.js';
test('shared admission preserves preference, explicit agent-provider choice and strict budgets',()=>{
  assert.equal(admitRun({goal:'Read'},'typesafe-jev',true).provider,'typesafe-jev');
  assert.equal(admitRun({goal:'Read',provider:'codex-sdk'},'agent',false).provider,'codex-sdk');
  assert.throws(()=>admitRun({goal:'Read',provider:'codex-sdk'},'typesafe-jev',false),/provider_preference_mismatch/);
  assert.throws(()=>admitRun({goal:'Read'},'agent',false),/decision_provider_required/);
  assert.throws(()=>admitRun({goal:'Read',timeoutMs:999},'codex-sdk',false));
  assert.throws(()=>admitRun({goal:'Read',bypass:true},'codex-sdk',false));
  assert.equal(admitRun({goal:'Read'},'codex-sdk',true).options.readonly,true);
});
