import test from 'node:test';
import assert from 'node:assert/strict';
import {makePlan,summarize,digest} from '../scripts/webarena-publication.mjs';
const tasks=[{task_id:10,sites:['shopping'],intent:'public goal'},{task_id:20,sites:['gitlab'],intent:'another public goal'}];
function frozen(){const {plan_sha256,...plan}=makePlan(tasks,{suite:'unit-fixture'});plan.state='frozen';return {...plan,plan_sha256:digest(plan)};}
function records(plan){return plan.schedule.map(e=>({id:e.id,plan_sha256:plan.plan_sha256,outcome:'passed',response_ms:1000,cleanup_ms:100,clock:plan.clock,evaluator_verified:true,evidence_sha256:'a'.repeat(64)}));}
test('fixed schedule is deterministic and balances first position per task',()=>{
 const plan=makePlan(tasks,{suite:'unit-fixture'});assert.deepEqual(makePlan(tasks,{suite:'unit-fixture'}),plan);assert.equal(plan.schedule.length,18);
 for(const task of tasks)for(const config of plan.configurations)assert.equal(plan.schedule.filter(e=>e.task_id===task.task_id&&e.configuration===config.id&&e.position===0).length,1);
});
test('missing, invalid-environment and draft runs never produce headline scores',()=>{
 const plan=frozen(),all=records(plan);assert.equal(summarize(plan,all.slice(1)).publishable,false);
 assert.equal(summarize(plan,all.map((r,i)=>i? r:{...r,outcome:'environment_invalid'})).publishable,false);
 const draft=makePlan(tasks,{suite:'unit-fixture'});assert.equal(summarize(draft,records(draft)).configurations,null);
});
test('failed and unsupported episodes cost the common deadline, not their fast error time',()=>{
 const plan=frozen(),all=records(plan).map(r=>r.id.endsWith('-jev')?{...r,outcome:'unsupported',response_ms:10}:r);
 const report=summarize(plan,all),jev=report.configurations.find(c=>c.id==='jev');
 assert.equal(jev.success_rate,0);assert.equal(jev.mean_penalized_ms,600000);assert.equal(jev.successful_p50_ms,null);assert.equal(jev.cost,null);
 assert.deepEqual(report.comparisons.find(c=>c.configuration==='jev').success_difference_ci95,[-1,-1]);
});
test('mixed clocks, duplicate episodes, altered schedules and unjudged success are rejected',()=>{
 const plan=frozen(),all=records(plan);
 assert.throws(()=>summarize(plan,[...all,all[0]]),/duplicate/);
 assert.throws(()=>summarize(plan,[{...all[0],clock:'model_only'}]),/clock_mismatch/);
 assert.throws(()=>summarize({...plan,deadline_ms:1},all),/hash/);
 assert.throws(()=>summarize(plan,[{...all[0],evaluator_verified:false}]),/unverified/);
});

test('a small task selection cannot be labeled a complete upstream suite',()=>{assert.throws(()=>makePlan(tasks),/suite_size_mismatch/);assert.throws(()=>makePlan(tasks,{suite:'webarena-verified-hard'}),/suite_size_mismatch/);});
