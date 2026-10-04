// Opt-in live pilot. All scored navigation/reading goes through Tabora MCP and its
// local controller. Playwright is used only to launch the isolated test profile,
// prepare the public benchmark login, and close test resources.
import {chromium} from 'playwright';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {mkdir,mkdtemp,readFile,writeFile,cp,rm} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const args=process.argv.slice(2),arg=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
if(!args.includes('--live')||!args.includes('--tasks')||!args.includes('--output'))throw new Error('Requires --live --tasks protocol.json --output directory; consumes provider inference.');
const origin=arg('--origin')??'http://127.0.0.1:7780';assert.equal(new URL(origin).hostname,'127.0.0.1');
const tasks=JSON.parse(await readFile(arg('--tasks'),'utf8')).tasks.map(({id,intent})=>({id,intent}));
const output=path.resolve(arg('--output'));await mkdir(output,{recursive:true});
const previous=await readFile(path.join(output,'runs.json'),'utf8').then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
if(previous)throw new Error('Output already contains frozen runs; choose a new directory.');
const providers=args.includes('--provider')?[arg('--provider')]:['codex-sdk','typesafe-jev'];
if(providers.some(provider=>!['codex-sdk','typesafe-jev'].includes(provider)))throw new Error('This live harness supports codex-sdk and typesafe-jev only.');
const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const dir=await mkdtemp(path.join(base,'webarena-')),extension=path.join(dir,'extension'),state=path.join(dir,'state');
await cp('dist/extension',extension,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));manifest.host_permissions=[origin+'/*'];await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
const extensionId=(await readFile('extension-id.txt','utf8')).trim();
const client=new Client({name:'tabora-webarena-local-controller',version:'1.0.0'});let context;const runs=[];
async function tool(name,args={}){const reply=await client.callTool({name,arguments:args});const data=JSON.parse(reply.content.find(c=>c.type==='text').text);if(reply.isError)throw new Error(data.code);return data;}
try{
  context=await chromium.launchPersistentContext(path.join(dir,'profile'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],env:{...process.env,TABORA_STATE_DIR:state,TABORA_BROWSER_NAME:'WebArena isolated pilot'},viewport:{width:1280,height:1000}});
  const prep=await context.newPage();await prep.setExtraHTTPHeaders({'X-M2-Admin-Auto-Login':'admin:admin1234'});await prep.goto(origin+'/admin/admin/dashboard/');await prep.waitForSelector('#nav');await prep.setExtraHTTPHeaders({});
  const panel=await context.newPage();await panel.goto(`chrome-extension://${extensionId}/panel.html`);await panel.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Lokální host připojený',undefined,{timeout:30000});
  const rpc=async(command,payload)=>{const reply=await panel.evaluate(({command,payload})=>chrome.runtime.sendMessage({command,payload}),{command,payload});if(!reply.ok)throw new Error(reply.code);return reply.data;};
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/host/mcp.js')],env:{...process.env,TABORA_STATE_DIR:state},stderr:'pipe'}));
  const profile=(await tool('browser_profiles'))[0];assert(profile);
  for(const provider of providers){
    const model=provider==='codex-sdk'?(arg('--codex-model')??'gpt-6.1-sol'):(arg('--jev-model')??'jev-latest');
    await rpc('configure',{provider,model,connection:provider==='codex-sdk'?'sdk':'environment',timeoutMs:60000});await rpc('profile.update',{activeProvider:provider});
    for(const task of tasks){
      const session=await tool('browser_session_create',{profileId:profile.id,name:`${provider} task ${task.id}`});
      const opened=await tool('browser_session_open',{sessionId:session.id,url:origin+'/admin/admin/dashboard/',waitForReady:true});assert(opened.attached);
      const started=performance.now();let terminal;
      try{
        const run=await tool('browser_run_start',{sessionId:session.id,goal:task.intent,maxSteps:20,timeoutMs:300000});
        do{await new Promise(resolve=>setTimeout(resolve,100));terminal=await tool('browser_run_status',{runId:run.id});}while(terminal.status==='running');
      }catch(error){terminal={status:'failed',code:error.message};}
      const result={arm:'tabora-'+provider+'-local-fixed',taskId:task.id,wallMs:Math.round(performance.now()-started),answer:terminal.status==='completed'?terminal.answer:null,error:terminal.code??null,terminal};runs.push(result);
      await writeFile(path.join(output,'runs.json'),JSON.stringify(runs,null,2));console.log(JSON.stringify({arm:result.arm,taskId:task.id,status:terminal.status,answer:result.answer,wallMs:result.wallMs,error:result.error}));
      await tool('browser_session_release',{sessionId:session.id});
    }
  }
}finally{
  await client.close().catch(()=>{});await context?.close();assert.equal(path.dirname(path.resolve(dir)),base);await rm(dir,{recursive:true,force:true,maxRetries:5});
}
