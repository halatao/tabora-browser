import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { toolDefinitions } from '../browser-api.js';
import { safeCode } from '../shared.js';
import { connectBroker } from './broker-client.js';
const peer=await connectBroker('mcp');
const server=new McpServer({name:'tabora-browser',version:'0.2.0'});
for(const [name,definition] of Object.entries(toolDefinitions)){
  server.registerTool(name,{description:definition.description,inputSchema:definition.schema},async(args:any)=>{
    try{const result=await peer.call('tool',{name,arguments:args});return {content:[{type:'text' as const,text:JSON.stringify(result)}]};}
    catch(error){return {isError:true,content:[{type:'text' as const,text:JSON.stringify({code:safeCode(error)})}]};}
  });
}
const transport=new StdioServerTransport();server.server.onclose=()=>peer.close();peer.onclose=()=>{void server.close();};await server.connect(transport);
