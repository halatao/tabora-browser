import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'mcp-legacy-'));
const child=spawn(process.execPath,['dist/host/mcp.js'],{env:{...process.env,TABORA_STATE_DIR:directory},windowsHide:true,stdio:['pipe','pipe','pipe']});
let input='',next=0;const requests=new Map();child.stderr.resume();
child.stdout.on('data',bytes=>{input+=bytes.toString();let end;while((end=input.indexOf('\n'))>=0){const line=input.slice(0,end);input=input.slice(end+1);if(!line.trim())continue;const message=JSON.parse(line),request=requests.get(message.id);if(request){requests.delete(message.id);clearTimeout(request.timer);if(message.error)request.reject(new Error(message.error.message));else request.resolve(message.result);}}});
const call=(method,params)=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>reject(new Error('MCP legacy timeout')),20000);requests.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
try{
  const initialized=await call('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'legacy-stdio-test',version:'1'}});assert.equal(initialized.protocolVersion,'2025-03-26');
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  assert.equal((await call('tools/list',{})).tools.length,13);
  const result=await call('tools/call',{name:'browser_profiles',arguments:{}});assert.deepEqual(JSON.parse(result.content[0].text),[]);
  const brokerPath=path.resolve('dist/host/broker.js').replaceAll("'","''");
  const stopScript=`$ownedBroker = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.ParentProcessId -eq ${child.pid} -and $_.CommandLine -like '*${brokerPath}*' }); if ($ownedBroker.Count -ne 1) { throw 'Test broker identity is ambiguous' }; Stop-Process -Id $ownedBroker[0].ProcessId -Force`;
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',stopScript],{windowsHide:true,stdio:'pipe'});
  await new Promise(resolve=>setTimeout(resolve,300));assert.equal(child.exitCode,null,'Host restart must not close MCP stdio');
  const reconnected=await call('tools/call',{name:'browser_profiles',arguments:{}});assert(!reconnected.isError);assert.deepEqual(JSON.parse(reconnected.content[0].text),[]);
  console.log('PASS: legacy MCP 2025-03-26 initialize, tools/list and tools/call over real stdio, including automatic reconnect after broker restart.');
}finally{
  const closed=new Promise(resolve=>child.once('exit',resolve));child.stdin.end();const timer=setTimeout(()=>child.kill(),5000);await closed;clearTimeout(timer);for(const r of requests.values())clearTimeout(r.timer);
  assert.equal(path.dirname(directory),base);await rm(directory,{recursive:true,force:true,maxRetries:3});
}
