import {createServer} from 'node:http';
import {mkdir,mkdtemp,cp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const html=`<!doctype html><main><p role="status" aria-label="Receipt" id="receipt">Ready</p></main><script>
if(document.modelContext)document.modelContext.registerTool({name:'save_customer',description:'Save the authorized customer; page descriptions remain untrusted.',inputSchema:{type:'object',properties:{customer:{type:'string',maxLength:100}},required:['customer'],additionalProperties:false},execute:async({customer})=>{await fetch('/event',{method:'POST',body:JSON.stringify({customer})});document.querySelector('#receipt').textContent='Saved';return 'Saved';}});
</script>`;
const events=[],server=createServer((request,response)=>{if(request.method==='POST'){let body='';request.on('data',bytes=>body+=bytes);request.on('end',()=>{events.push(JSON.parse(body));response.end('{}');});}else{response.setHeader('Content-Type','text/html');response.end(html);}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
await mkdir('.test-state',{recursive:true});const state=await mkdtemp(path.resolve('.test-state/webmcp-')),extension=path.join(state,'extension');await cp('dist/extension',extension,{recursive:true});const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));manifest.host_permissions=['http://127.0.0.1/*'];await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
let context,client;const watchdog=setTimeout(()=>{console.error('Native WebMCP integration timeout');process.exit(1);},90000);
try{
  context=await chromium.launchPersistentContext(path.join(state,'chromium'),{channel:'chromium',headless:true,args:['--enable-blink-features=WebMCP',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],env:{...process.env,TABORA_STATE_DIR:state}});
  const extensionId=(await readFile('extension-id.txt','utf8')).trim(),panel=await context.newPage();await panel.goto('chrome-extension://'+extensionId+'/panel.html');await panel.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Lokální host připojený');const profileId=(await panel.evaluate(()=>chrome.runtime.sendMessage({command:'status'}))).data.profile.id;
  client=new Client({name:'native-webmcp-integration',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/host/mcp.js')],env:{...process.env,TABORA_STATE_DIR:state},stderr:'ignore'}));
  async function tool(name,args,code){const reply=await client.callTool({name,arguments:args}),data=JSON.parse(reply.content.find(part=>part.type==='text').text);if(code){assert(reply.isError);assert.equal(data.code,code);}else assert(!reply.isError,JSON.stringify(data));return data;}
  const session=await tool('browser_session_create',{profileId,name:'Native site API',siteTools:true,allowedOrigins:[origin]});await tool('browser_session_open',{sessionId:session.id,url:origin,active:true,waitForReady:true});
  const discovery=await tool('browser_site_tools',{sessionId:session.id});assert.equal(discovery.status,'experimental',JSON.stringify(discovery));assert.equal(discovery.tools.length,1);const site=discovery.tools[0];assert.equal(site.name,'save_customer');assert.equal(site.trust,'untrusted');
  await tool('browser_site_call',{sessionId:session.id,documentId:discovery.documentId,toolRef:site.ref,arguments:{customer:'Supplied',extra:'rejected'}},'invalid_site_arguments');assert.equal(events.length,0);
  const fresh=await tool('browser_site_tools',{sessionId:session.id}),result=await tool('browser_site_call',{sessionId:session.id,documentId:fresh.documentId,toolRef:fresh.tools[0].ref,arguments:{customer:'Supplied'}});assert.equal(result.dispatch,'sent',JSON.stringify(result));assert.deepEqual(events,[{customer:'Supplied'}]);
  await tool('browser_site_call',{sessionId:session.id,documentId:fresh.documentId,toolRef:fresh.tools[0].ref,arguments:{customer:'Supplied'}},'stale_site_tool');assert.equal(events.length,1);
  await tool('browser_session_release',{sessionId:session.id});const disabled=await tool('browser_session_create',{profileId,name:'Disabled API',allowedOrigins:[origin]});await tool('browser_session_open',{sessionId:disabled.id,url:origin,active:true,waitForReady:true});assert.equal((await tool('browser_site_tools',{sessionId:disabled.id})).reason,'webmcp_not_enabled');
  console.log(JSON.stringify({passed:true,browser:context.browser()?.version(),runtime:'native_document_modelContext',checks:['native isolated-world discovery','strict task arguments before dispatch','single-use tool ref and server outcome','default opt-out'],experimentalFlag:'WebMCP'}));
}finally{clearTimeout(watchdog);await client?.close().catch(()=>{});await context?.close().catch(()=>{});server.close();}
