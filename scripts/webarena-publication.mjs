import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const random=seed=>()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t^=t+Math.imul(t^t>>>7,61|t);return ((t^t>>>14)>>>0)/4294967296;};
function shuffle(items,rng){const result=[...items];for(let i=result.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[result[i],result[j]]=[result[j],result[i]];}return result;}
export function makePlan(tasks,{suite='webarena-verified-full',seed=20261004}={}){
 if(suite==='webarena-verified-full'&&tasks.length!==812||suite==='webarena-verified-hard'&&tasks.length!==258)throw Error('suite_size_mismatch');
 if(!tasks.length||new Set(tasks.map(t=>t.task_id)).size!==tasks.length)throw Error('invalid_task_inventory');
 const configurations=[{id:'official',product:'official Chrome extension + external calling agent',model:'unattested',entry:'official-extension',vault:false},{id:'jev',product:'Tabora',model:'jev-latest',entry:'installed-extension-mcp',vault:false},{id:'luna',product:'Tabora',model:'gpt-6-luna',entry:'installed-extension-mcp',vault:false}];
 const rng=random(seed),blocks=[];
 for(const task of tasks){if(!Number.isInteger(task.task_id)||!Array.isArray(task.sites)||!task.sites.length)throw Error('invalid_public_task');const base=shuffle(configurations.map(c=>c.id),rng);for(let repetition=0;repetition<3;repetition++)blocks.push({task_id:task.task_id,repetition,sites:task.sites,order:[...base.slice(repetition),...base.slice(0,repetition)]});}
 const schedule=shuffle(blocks,rng).flatMap(b=>b.order.map((configuration,position)=>({id:`${b.task_id}-${b.repetition}-${configuration}`,task_id:b.task_id,repetition:b.repetition,configuration,position,sites:b.sites})));
 const inventory=tasks.map(t=>({task_id:t.task_id,sites:t.sites})).sort((a,b)=>a.task_id-b.task_id);
 const plan={schema:1,state:'draft_not_ready_for_execution',suite,evaluator:'webarena-verified==1.2.3',seed,repetitions:3,deadline_ms:600000,lane:'time-budget-only',clock:'operator_monotonic_goal_delivery_to_terminal_response',cleanup_clock:'separate',configurations,inventory,inventory_sha256:digest(inventory),public_input_sha256:digest(tasks),schedule,schedule_sha256:digest(schedule),development_exposure:[0,77,94,127],publication_gates:['all sites healthy and reset verified','equivalent isolated profiles, vault off','pinned image digests and product builds','official supported entry point ready','operator/oracle isolation enforced','identical clock and deadline enforced','all scheduled episodes recorded']};
 return {...plan,plan_sha256:digest(plan)};
}
const percentile=(values,q)=>{if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.ceil(q*sorted.length)-1];};
export function summarize(plan,records){
 const {plan_sha256,...body}=plan;if(digest(body)!==plan_sha256||digest(plan.schedule)!==plan.schedule_sha256)throw Error('plan_hash_mismatch');
 const scheduled=new Map(plan.schedule.map(e=>[e.id,e]));if(scheduled.size!==plan.schedule.length)throw Error('duplicate_schedule');
 const seen=new Map();
 for(const record of records){const episode=scheduled.get(record.id);if(!episode||seen.has(record.id))throw Error('unknown_or_duplicate_episode');if(!['passed','failed','unsupported','timeout','environment_invalid'].includes(record.outcome))throw Error('invalid_outcome');if(!Number.isFinite(record.response_ms)||record.response_ms<0||record.response_ms>plan.deadline_ms||!Number.isFinite(record.cleanup_ms)||record.cleanup_ms<0)throw Error('invalid_clock');if(record.clock!==plan.clock)throw Error('clock_mismatch');if(record.plan_sha256!==plan.plan_sha256)throw Error('record_plan_mismatch');if(record.outcome==='passed'&&(!record.evaluator_verified||!/^[a-f0-9]{64}$/.test(record.evidence_sha256??'')))throw Error('unverified_success');seen.set(record.id,record);}
 const missing=plan.schedule.filter(e=>!seen.has(e.id)).map(e=>e.id),invalid=records.filter(r=>r.outcome==='environment_invalid').map(r=>r.id);
 if(plan.state!=='frozen'||missing.length||invalid.length)return {publishable:false,scheduled:plan.schedule.length,recorded:records.length,missing,environment_invalid:invalid,reason:plan.state!=='frozen'?'plan_not_frozen':'incomplete_or_invalid_run',configurations:null};
 const configurations=plan.configurations.map(config=>{
  const episodes=plan.schedule.filter(e=>e.configuration===config.id).map(e=>({...seen.get(e.id),task_id:e.task_id}));
  const passed=episodes.filter(r=>r.outcome==='passed');const times=passed.map(r=>r.response_ms);
  return {id:config.id,episodes:episodes.length,passed:passed.length,success_rate:passed.length/episodes.length,unsupported:episodes.filter(r=>r.outcome==='unsupported').length,timeouts:episodes.filter(r=>r.outcome==='timeout').length,mean_penalized_ms:episodes.reduce((sum,r)=>sum+(r.outcome==='passed'?r.response_ms:plan.deadline_ms),0)/episodes.length,successful_p50_ms:percentile(times,.5),successful_p95_ms:percentile(times,.95),mean_cleanup_ms:episodes.reduce((sum,r)=>sum+r.cleanup_ms,0)/episodes.length,completion_curve:Object.fromEntries([30,60,120,300,600].map(seconds=>[seconds,passed.filter(r=>r.response_ms<=seconds*1000).length/episodes.length])),cost:null};
 });
 const comparisons=[];const taskIds=plan.inventory.map(t=>t.task_id);const rng=random(plan.seed);
 for(const config of plan.configurations.filter(c=>c.id!=='official')){
  const taskMetrics=taskIds.map(task=>{
   const metrics=id=>plan.schedule.filter(e=>e.task_id===task&&e.configuration===id).map(e=>seen.get(e.id));const own=metrics(config.id),baseline=metrics('official');
   const success=items=>items.filter(r=>r.outcome==='passed').length/items.length;const latency=items=>items.reduce((sum,r)=>sum+(r.outcome==='passed'?r.response_ms:plan.deadline_ms),0)/items.length;
   return {success:success(own)-success(baseline),latency:latency(own)-latency(baseline)};
  });
  const success=[],latency=[];for(let i=0;i<2000;i++){let s=0,l=0;for(let j=0;j<taskMetrics.length;j++){const sample=taskMetrics[Math.floor(rng()*taskMetrics.length)];s+=sample.success;l+=sample.latency;}success.push(s/taskMetrics.length);latency.push(l/taskMetrics.length);}
  comparisons.push({configuration:config.id,baseline:'official',cluster:'task_id',bootstrap_samples:2000,success_difference:taskMetrics.reduce((s,r)=>s+r.success,0)/taskMetrics.length,success_difference_ci95:[percentile(success,.025),percentile(success,.975)],penalized_latency_difference_ms:taskMetrics.reduce((s,r)=>s+r.latency,0)/taskMetrics.length,penalized_latency_difference_ci95_ms:[percentile(latency,.025),percentile(latency,.975)]});
 }
 return {publishable:true,suite:plan.suite,plan_sha256:plan.plan_sha256,configurations,comparisons};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [command,input,output,extra]=process.argv.slice(2);
 if(command==='plan'){const tasks=JSON.parse(await readFile(input,'utf8'));await writeFile(output,JSON.stringify(makePlan(tasks),null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({draft:output,tasks:tasks.length,episodes:tasks.length*9}));}
 else if(command==='report'){const plan=JSON.parse(await readFile(input,'utf8'));const records=JSON.parse(await readFile(extra,'utf8'));const result=summarize(plan,records);await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({publishable:result.publishable,output}));if(!result.publishable)process.exitCode=2;}
 else throw Error('Usage: plan public-tasks.json plan.json OR report plan.json report.json records.json');
}
