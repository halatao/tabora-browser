import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'mcp-update-'));
const client=new Client({name:'update-notice-regression',version:'1'});
try{
  await writeFile(path.join(directory,'update-check.json'),JSON.stringify({checkedAt:Date.now(),latestVersion:'99.0.0',source:'release'}));
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/host/mcp.js')],env:{...process.env,TABORA_STATE_DIR:directory,TABORA_UPDATE_CHECK:'1'},stderr:'ignore'}));
  const reply=await client.callTool({name:'browser_update_check',arguments:{}});assert(!reply.isError);
  const result=JSON.parse(reply.content[0].text);assert.equal(result.status,'update_available');assert.equal(result.latestVersion,'99.0.0');assert.equal(result.automaticInstallation,false);
  const notice=reply.content.slice(1).map(block=>JSON.parse(block.text)).find(value=>value.taboraNotice==='update_available');assert(notice);assert(notice.instruction.includes('current chat')||notice.instruction.includes('this chat'));assert(notice.steps.some(step=>step.includes('git pull --ff-only')));
  const profiles=await client.callTool({name:'browser_profiles',arguments:{}});assert.deepEqual(JSON.parse(profiles.content[0].text),[]);assert.equal(profiles.content.length,1,'Same version is not announced repeatedly');
  const disabled=new Client({name:'disabled-update-check-fixture',version:'1'});
  try{
    await disabled.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/host/mcp.js')],env:{...process.env,TABORA_STATE_DIR:directory,TABORA_UPDATE_CHECK:'0'},stderr:'ignore'}));
    const checked=await disabled.callTool({name:'browser_update_check',arguments:{refresh:true}});assert.equal(JSON.parse(checked.content[0].text).status,'disabled');
    const prepared=await disabled.callTool({name:'browser_update_prepare',arguments:{}});assert(prepared.isError);assert.equal(JSON.parse(prepared.content[0].text).code,'update_checks_disabled');
  }finally{await disabled.close();}
  console.log('PASS: actual MCP stdio delivers update/version/steps as a separate once-only notice; first JSON result stays compatible; no installation or network request required.');
}finally{await client.close().catch(()=>{});assert.equal(path.dirname(directory),base);await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
