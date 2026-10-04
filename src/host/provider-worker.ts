import { runAdapter, type AdapterRuntime } from './adapters.js';
import { configSchema, requestSchema, PilotError, safeCode } from '../shared.js';
const runtime:AdapterRuntime={};let controller:AbortController|undefined,closing=false;
async function close(){if(closing)return;closing=true;controller?.abort();await runtime.codex?.close();process.disconnect?.();}
process.on('disconnect',()=>{void close();setTimeout(()=>process.exit(1),1000).unref();});
process.on('message',async(message:any)=>{
  if(message?.kind==='cancel'){void close();return;}
  if(message?.kind!=='start'||closing)return;
  if(controller){process.send?.({id:message.id,ok:false,code:'session_busy'});return;}
  const active=new AbortController();controller=active;
  try {
    const request=requestSchema.parse(message.request), config=configSchema.parse(message.config);
    const result=await runAdapter(request,config,message.apiKey,message.directory,active,undefined,runtime);
    if(!closing)process.send?.({id:message.id,ok:true,result});
  } catch(error) {
    process.send?.({id:message.id,ok:false,code:active.signal.aborted?'cancelled':error instanceof PilotError?safeCode(error):'provider_failed'});
    await close();
  } finally {controller=undefined;}
});
