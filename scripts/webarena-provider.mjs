import path from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const client=new Client({name:'webarena-operator-config',version:'1'}),profileId=process.argv[2];
const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});const v=JSON.parse(r.content.find(x=>x.type==='text').text);if(r.isError)throw Error(v.code);return v;};
try{
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve(import.meta.dirname,'../dist/host/mcp.js')],env:process.env,stderr:'ignore'}));
  if(process.argv[3]==='status')console.log(JSON.stringify(await call('browser_provider_status',{profileId})));
  else if(process.argv[3]==='set'){
    const provider=process.argv[4],model=process.argv[5];
    if(!['codex-sdk','typesafe-jev'].includes(provider))throw Error('unsupported_configuration');
    const connection=provider==='codex-sdk'?'sdk':'environment';
    await call('browser_provider_configure',{profileId,provider,model,connection,timeoutMs:30000,settingsScope:'host'});
    await call('browser_provider_select',{profileId,provider});console.log(JSON.stringify({configured:true,provider,model}));
  }else if(process.argv[3]==='restore'){
    let raw='';for await(const part of process.stdin)raw+=part;
    const previous=JSON.parse(raw);
    const current=await call('browser_provider_status',{profileId});
    for(const config of previous.configs.filter(c=>['codex-sdk','typesafe-jev'].includes(c.provider)&&c.model&&JSON.stringify(current.configs.find(x=>x.provider===c.provider))!==JSON.stringify(c)))await call('browser_provider_configure',{profileId,...config,settingsScope:'host'});
    await call('browser_provider_select',{profileId,provider:previous.activeProvider});console.log(JSON.stringify({restored:true}));
  }else throw Error('unknown_command');
}finally{await client.close();}
