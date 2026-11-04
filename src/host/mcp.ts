import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { toolDefinitions } from '../browser-api.js';
import { safeCode,safeErrorDetails } from '../shared.js';
import { connectBroker } from './broker-client.js';
import { McpConnection } from './mcp-connection.js';
import {buildInfo} from '../build-info.js';
import {updateSteps} from './updates.js';
const connection=new McpConnection(()=>connectBroker('mcp'));await connection.ready();
let update:any,updatePending:Promise<void>|undefined,lastCheck=0;
const announced=new Set<string>();
function checkUpdates(){
  if(process.env.TABORA_UPDATE_CHECK==='0')return;
  if(updatePending||Date.now()-lastCheck<6*60*60*1000)return;
  lastCheck=Date.now();updatePending=connection.call('tool',{name:'browser_update_check',arguments:{refresh:false}}).then(result=>{update=result;},error=>{if(['unknown_tool','unknown_command'].includes(safeCode(error)))update={status:'unavailable',code:'broker_update_required',steps:updateSteps,installed:buildInfo};}).finally(()=>{updatePending=undefined;});
}
function notices(result:any){
  const content:{type:'text';text:string}[]=[];
  if(['mcp_restart_required','profile_connection_required','recovery_required','rolled_back','consent_required'].includes(result?.status)){
    const key=result.id+':'+result.status;
    if(!announced.has(key)){announced.add(key);content.push({type:'text',text:JSON.stringify({taboraNotice:result.status,updateId:result.id,instruction:result.nextStep??'Explain the update state to the user. Reconnect MCP if required; never replay an uncertain browser write.'})});}
  }
  if(update?.status==='update_available'&&!announced.has(update.latestVersion)){announced.add(update.latestVersion);content.push({type:'text',text:JSON.stringify({taboraNotice:'update_available',instruction:'Tell the user in this chat that a new Tabora version is available and guide them through these local update steps. Finish active work first; never replay an uncertain write.',...update})});}
  if(update?.code==='broker_update_required'&&!announced.has('broker_update_required')){announced.add('broker_update_required');content.push({type:'text',text:JSON.stringify({taboraNotice:'broker_update_required',instruction:'Tell the user the running Tabora broker is older than this MCP server and guide them through a safe restart after finishing active work.',...update})});}
  if(result?.build?.compatible===false||result?.build?.sameBuild===false||result?.build?.host&&result.build.host.fingerprint!==buildInfo.fingerprint){const key=JSON.stringify(result.build);if(!announced.has(key)){announced.add(key);content.push({type:'text',text:JSON.stringify({taboraNotice:'build_mismatch',build:result.build,mcp:buildInfo,instruction:result.build.compatible===false?'Explain the incompatible component contracts. Finish active work and use browser_update_check for the installed channel and bootstrap/reconnect steps; never replay an uncertain write.':'Report component version differences. Compatible Store and host builds may differ. Use browser_update_check for the installed channel; do not force a browser reload solely because fingerprints differ.'})});}}
  return content;
}
checkUpdates();
const server=new McpServer({name:'tabora-browser',version:buildInfo.version});
for(const [name,definition] of Object.entries(toolDefinitions)){
  server.registerTool(name,{description:definition.description,inputSchema:definition.schema},async(args:any)=>{
    if(process.env.TABORA_UPDATE_CHECK==='0'&&name==='browser_update_check')return {content:[{type:'text' as const,text:JSON.stringify({status:'disabled',installed:buildInfo,automaticInstallation:false})}]};
    if(process.env.TABORA_UPDATE_CHECK==='0'&&name==='browser_update_prepare')return {isError:true,content:[{type:'text' as const,text:JSON.stringify({code:'update_checks_disabled'})}]};
    try{checkUpdates();const result=await connection.call('tool',{name,arguments:args});if(name==='browser_update_check')update=result;if(name==='browser_image_view'){const {image,...metadata}=result;return {content:[{type:'image' as const,data:image.data,mimeType:image.mimeType},{type:'text' as const,text:JSON.stringify({...metadata,...image,data:undefined})},...notices(result)]};}return {content:[{type:'text' as const,text:JSON.stringify(result)},...notices(result)]};}
    catch(error){if(name==='browser_update_check'&&['unknown_tool','unknown_command'].includes(safeCode(error))){update={status:'unavailable',code:'broker_update_required',steps:updateSteps,installed:buildInfo};return {content:[{type:'text' as const,text:JSON.stringify(update)},...notices(undefined)]};}return {isError:true,content:[{type:'text' as const,text:JSON.stringify({code:safeCode(error),details:safeErrorDetails(error)})},...notices(undefined)]};}
  });
}
const transport=new StdioServerTransport();server.server.onclose=()=>connection.close();await server.connect(transport);
process.stdin.once('end',()=>{connection.close();void server.close().finally(()=>process.exit(0));});
