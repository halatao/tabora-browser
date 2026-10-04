// Opt-in live benchmark against the already connected Chrome profile.
// No profile settings, cookies, credentials, or extension configuration are changed.
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
const args=process.argv.slice(2),arg=n=>args[args.indexOf(n)+1];
if(!args.includes('--live'))throw Error('Requires --live');
const output=path.resolve(arg('--output')),provider=arg('--provider');
await mkdir(output,{recursive:true});
const file=path.join(output,provider+'-runs.json');
try{await readFile(file);throw Error('Frozen output already exists');}catch(e){if(e.code!=='ENOENT')throw e;}
const protocol=JSON.parse(await readFile(path.join(output,'protocol.json'),'utf8'));
const client=new Client({name:'tabora-chrome-benchmark',version:'1.0.0'});
const runs=[];
async function tool(name,input={}){const reply=await client.callTool({name,arguments:input});const data=JSON.parse(reply.content.find(c=>c.type==='text').text);if(reply.isError)throw Error(data.code??JSON.stringify(data));return data;}
try{
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/host/mcp.js')],stderr:'pipe'}));
 const profile=(await tool('browser_profiles')).find(p=>p.id===protocol.profileId);
 if(!profile||profile.activeProvider!==provider)throw Error('Selected profile/provider does not match protocol');
 await writeFile(path.join(output,provider+'-profile.json'),JSON.stringify(profile,null,2));
 for(const task of protocol.tasks){
  let session,terminal,wallMs=0;
  try{
   session=await tool('browser_session_create',{profileId:profile.id,name:`Benchmark ${provider} ${task.id}`});
   const opened=await tool('browser_session_open',{sessionId:session.id,url:protocol.startUrl,waitForReady:true,active:protocol.activeTab??false});
   if(!opened.attached)throw Error('Document not attached');
   const started=performance.now();
   try{
    const run=await tool('browser_run_start',{sessionId:session.id,goal:task.intent,maxSteps:20,timeoutMs:300000});
    do{await new Promise(r=>setTimeout(r,100));terminal=await tool('browser_run_status',{runId:run.id});}while(terminal.status==='running');
   }catch(e){terminal={status:'failed',code:e.message};}
   wallMs=Math.round(performance.now()-started);
  }catch(e){terminal={status:'setup_failed',code:e.message};}
  const result={arm:'tabora-'+provider,taskId:task.id,wallMs,answer:terminal.status==='completed'?terminal.answer:null,error:terminal.code??null,terminal};
  runs.push(result);await writeFile(file,JSON.stringify(runs,null,2));
  console.log(JSON.stringify({arm:result.arm,taskId:task.id,wallMs,answer:result.answer,status:terminal.status,error:result.error}));
  if(session)await tool('browser_session_release',{sessionId:session.id});
 }
}finally{await client.close();}
