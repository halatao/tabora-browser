import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {z} from 'zod';
import {PilotError,type ProviderConfig} from '../shared.js';
import {CodexDecisionSession} from './codex-session.js';
import {sdkEnvironment} from './sdk-environment.js';
export interface ProviderCatalog {state:string;models:{id:string;label:string;isDefault?:boolean}[];source?:string;}
export async function providerCatalog(config:ProviderConfig,directory:string,key?:string,fetcher:typeof fetch=fetch):Promise<ProviderCatalog>{
  if(config.provider==='openai-decisions')return {state:'preview_unavailable',models:[]};
  if(config.provider==='typesafe-jev'){
    if(!key)return {state:'missing_api_key',models:[]};
    const response=await fetcher('https://api.typesafe.ai/v1/models',{headers:{authorization:'Bearer '+key},signal:AbortSignal.timeout(12000),redirect:'error'});
    if(!response.ok)throw new PilotError(response.status===401||response.status===403?'authentication_failed':'provider_failed');
    const data=z.object({models:z.array(z.object({name:z.string().max(120)})).max(200)}).parse(await response.json());
    return {state:'connected',models:data.models.map(m=>({id:m.name,label:m.name})),source:'account'};
  }
  const cwd=path.join(directory,'sdk-metadata');await mkdir(cwd,{recursive:true});
  const env=sdkEnvironment();
  if(config.provider==='codex-sdk'){
    if(config.connection==='vault'){
      if(!key)return {state:'missing_api_key',models:[]};
      const response=await fetcher('https://api.openai.com/v1/models',{headers:{authorization:'Bearer '+key},signal:AbortSignal.timeout(12000),redirect:'error'});
      if(!response.ok)throw new PilotError(response.status===401||response.status===403?'authentication_failed':'provider_failed');
      const data=z.object({data:z.array(z.object({id:z.string().min(1).max(120)})).max(2000)}).parse(await response.json());
      // API catalogs include audio, images and embeddings. Offer text-model families only;
      // exact Responses/structured-output compatibility is validated by the first decision.
      const ids=[...new Set(data.data.map(m=>m.id).filter(id=>/^(gpt-|o\d|codex-)/.test(id)&&!/(audio|realtime|transcrib|tts|image|search|instruct)/.test(id)))].sort();
      return {state:'connected',models:ids.map(id=>({id,label:id})),source:'account'};
    }
    const session=new CodexDecisionSession({cwd,env});try{return {...await session.catalog(),source:'sdk_catalog'};}finally{await session.close();}
  }
  const {query}=await import('@anthropic-ai/claude-agent-sdk');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  async function* idle():AsyncGenerator<any>{await new Promise<void>(resolve=>controller.signal.addEventListener('abort',()=>resolve(),{once:true}));}
  const session=query({prompt:idle(),options:{cwd,abortController:controller,tools:[],mcpServers:{},strictMcpConfig:true,settingSources:[],plugins:[],persistSession:false,env:config.connection==='vault'?{...env,ANTHROPIC_API_KEY:key??''}:env,stderr:()=>{},canUseTool:async()=>({behavior:'deny',message:'Metadata only'})}});
  try{
    const [models,account]=await Promise.all([session.supportedModels(),session.accountInfo()]);
    const choices=models.map((m,i)=>({id:m.resolvedModel??m.value,label:m.displayName,isDefault:i===0}));
    return {state:account.email||account.subscriptionType||(account.apiKeySource&&account.apiKeySource!=='none')?'connected':'login_required',models:choices.filter((m,i)=>choices.findIndex(c=>c.id===m.id)===i),source:'sdk_catalog'};
  }finally{clearTimeout(timer);controller.abort();session.close();}
}
