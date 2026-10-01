import { runAdapter } from './adapters.js';
import { configSchema, requestSchema, PilotError, safeCode } from '../shared.js';
const controller=new AbortController();
process.on('disconnect',()=>{controller.abort();setTimeout(()=>process.exit(1),1000).unref();});
process.on('message',async(message:any)=>{
  if(message?.kind==='cancel'){controller.abort();return;}
  if(message?.kind!=='start')return;
  try {
    const request=requestSchema.parse(message.request), config=configSchema.parse(message.config);
    const result=await runAdapter(request,config,message.apiKey,message.directory,controller);
    process.send?.({ok:true,result});
  } catch(error) {
    process.send?.({ok:false,code:controller.signal.aborted?'cancelled':error instanceof PilotError?safeCode(error):'provider_failed'});
  } finally {process.disconnect?.();}
});
