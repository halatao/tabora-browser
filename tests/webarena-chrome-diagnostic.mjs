import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
const client=new Client({name:'tabora-chrome-menu-diagnostic',version:'1'});
async function tool(name,input={}){const r=await client.callTool({name,arguments:input});const d=JSON.parse(r.content.find(c=>c.type==='text').text);if(r.isError)throw Error(d.code);return d;}
let session;
try{
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/host/mcp.js')],stderr:'pipe'}));
 session=await tool('browser_session_create',{profileId:'bfc2b5ac-7817-48b0-9464-a3253b4f34a3',name:'Benchmark diagnostic'});
 const active=process.argv.includes('--active');
 const opened=await tool('browser_session_open',{sessionId:session.id,url:'http://127.0.0.1:7780/admin/admin/dashboard/',waitForReady:true,active});
 const before=await tool('browser_observe',{sessionId:session.id,recipe:'all'});
 const target=before.snapshot.targets.find(t=>t.name.toLowerCase().includes('marketing'));
 if(!target)throw Error('Marketing target missing');
 const prepared=await tool('browser_prepare',{sessionId:session.id,recipe:'click',targetId:target.id});
 const stepped=await tool('browser_step',{sessionId:session.id,actionId:prepared.actionId,stateVersion:opened.binding.documentId+':'+before.snapshot.documentToken,expect:'change',timeoutMs:8000});
 const after=await tool('browser_observe',{sessionId:session.id,recipe:'all'});
 const next=after.snapshot.targets.find(t=>t.name.toLowerCase().includes('marketing'));
 const secondAction=await tool('browser_prepare',{sessionId:session.id,recipe:'click',targetId:next.id});
 const secondStep=await tool('browser_step',{sessionId:session.id,actionId:secondAction.actionId,stateVersion:stepped.binding.documentId+':'+after.snapshot.documentToken,expect:'change',timeoutMs:8000});
 const secondAfter=await tool('browser_observe',{sessionId:session.id,recipe:'all'});
 await writeFile('../webarena-pilot/rerun-2026-10-01-chrome/menu-diagnostic'+(active?'-active':'')+'.json',JSON.stringify({active,opened,before,stepped,after,secondStep,secondAfter},null,2));
 console.log(JSON.stringify({secondTargets:secondAfter.snapshot.targets.map(t=>t.name),secondTimings:secondStep.timings}));
 console.log(JSON.stringify({opened,marketing:target,afterTargets:after.snapshot.targets.map(t=>({name:t.name,contains:t.contains,kind:t.kind})),timings:stepped.timings}));
}finally{if(session)await tool('browser_session_release',{sessionId:session.id});await client.close();}
