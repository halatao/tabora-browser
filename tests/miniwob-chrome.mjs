// Opt-in bounded MiniWoB click-policy pilot; not browser_run_start's retrieval controller.
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const args=process.argv.slice(2),arg=n=>args[args.indexOf(n)+1];
if(!args.includes('--live'))throw Error('Requires --live');
const output=path.resolve(arg('--output'));
const protocol=JSON.parse(await readFile(path.join(output,'protocol.json'),'utf8'));
try{await readFile(path.join(output,'runs.json'));throw Error('Frozen runs already exist');}catch(e){if(e.code!=='ENOENT')throw e;}
const client=new Client({name:'tabora-miniwob-pilot',version:'1.0.0'}),runs=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function tool(name,input={}){const r=await client.callTool({name,arguments:input});const d=JSON.parse(r.content.find(c=>c.type==='text').text);if(r.isError)throw Error(d.code??'tool_error');return d;}
async function env(id,kind,data={}){const r=await fetch(protocol.baseUrl+'/_bench/'+id,kind?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,...data})}:{});if(!r.ok)throw Error('benchmark_server_error');return r.json();}
async function until(id,predicate,timeout=15000){const start=performance.now();while(performance.now()-start<timeout){const s=await env(id);if(predicate(s))return s;await sleep(25);}throw Error('benchmark_sync_timeout');}
try{
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/host/mcp.js')],stderr:'pipe'}));
 const profile=(await tool('browser_profiles')).find(p=>p.id===protocol.profileId);
 if(!profile||profile.activeProvider!==protocol.provider)throw Error('Selected profile/provider mismatch');
 await writeFile(path.join(output,'profile.json'),JSON.stringify(profile,null,2));
 for(const task of protocol.tasks)for(const seed of protocol.seeds){
  const id=task+'-'+seed;let session,started,wallMs=0,terminal,error=null;const trace=[];
  try{
   await env(id,'create',{task,seed});
   session=await tool('browser_session_create',{profileId:profile.id,name:`MiniWoB ${id}`});
   const opened=await tool('browser_session_open',{sessionId:session.id,url:`${protocol.baseUrl}/miniwob/${task}.html?episode=${id}&seed=${seed}`,active:false,waitForReady:true});
   if(!opened.attached)throw Error('not_attached');
   await until(id,s=>s.ready);started=performance.now();await env(id,'start');
   const begun=await until(id,s=>s.started);const history=[];
   for(let step=1;step<=protocol.maxSteps;step++){
    if((await env(id)).result)break;
    const observed=await tool('browser_observe',{sessionId:session.id,recipe:'click'});
    const decision=await tool('browser_decide',{sessionId:session.id,recipe:'click',provider:profile.activeProvider,question:`Task: ${begun.utterance}\nSelect the next observed clickable target to complete this task. Previously clicked targets: ${history.join(' -> ')||'none'}. If the required control is not represented, choose ask_user. Do not restart an episode.`});
    const entry={step,result:decision.result,target:decision.target?.name};trace.push(entry);
    if((await env(id)).result)break;
    if(!decision.canExecute){error=decision.result?.code??'no_executable_choice';break;}
    const tick=performance.now();const stepped=await tool('browser_step',{sessionId:session.id,actionId:decision.actionId,stateVersion:decision.result.stateVersion,expect:'none',timeoutMs:1000});
    entry.operationMs=Math.round(performance.now()-tick);entry.timings=stepped.timings;history.push(decision.target?.name??decision.result.choiceId);
   }
   terminal=await until(id,s=>s.result,15000);wallMs=Math.round(performance.now()-started);
  }catch(e){error=e.message;if(started){wallMs=Math.round(performance.now()-started);try{terminal=await until(id,s=>s.result,12000);}catch{}}}
  const result={task,seed,arm:'tabora-jev-click-policy',wallMs,rawReward:terminal?.result?.rawReward??null,reward:terminal?.result?.reward??null,nativeElapsedMs:terminal?.result?.elapsedMs??null,reason:terminal?.result?.reason??null,success:terminal?.result?.rawReward===1,error,trace};
  runs.push(result);await writeFile(path.join(output,'runs.json'),JSON.stringify(runs,null,2));console.log(JSON.stringify({task,seed,success:result.success,rawReward:result.rawReward,wallMs,error}));
  if(session)await tool('browser_session_release',{sessionId:session.id});
 }
}finally{await client.close();}
