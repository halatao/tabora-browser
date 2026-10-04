import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { toolDefinitions } from '../browser-api.js';
import { safeCode } from '../shared.js';
import { connectBroker } from './broker-client.js';
import { McpConnection } from './mcp-connection.js';
import {buildInfo} from '../build-info.js';
const connection=new McpConnection(()=>connectBroker('mcp'));await connection.ready();
const server=new McpServer({name:'tabora-browser',version:buildInfo.version});
for(const [name,definition] of Object.entries(toolDefinitions)){
  server.registerTool(name,{description:definition.description,inputSchema:definition.schema},async(args:any)=>{
    try{const result=await connection.call('tool',{name,arguments:args});if(name==='browser_image_view'){const {image,...metadata}=result;return {content:[{type:'image' as const,data:image.data,mimeType:image.mimeType},{type:'text' as const,text:JSON.stringify({...metadata,...image,data:undefined})}]};}return {content:[{type:'text' as const,text:JSON.stringify(result)}]};}
    catch(error){return {isError:true,content:[{type:'text' as const,text:JSON.stringify({code:safeCode(error)})}]};}
  });
}
const transport=new StdioServerTransport();server.server.onclose=()=>connection.close();await server.connect(transport);
