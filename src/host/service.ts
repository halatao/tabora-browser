import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { PROVIDERS, HOST_NAME, PROTOCOL_VERSION, PilotError, configSchema, providerId, requestSchema, vaultEntrySchema, idSchema, secretScopeSchema, exactOrigin, type ProviderConfig, type Binding } from '../shared.js';
import { Vault, atomicWrite } from './vault.js';
import { decide } from './providers.js';

const bindingSchema=z.object({tabId:z.number().int().nonnegative(),documentId:z.string().min(1).max(100),origin:z.string().max(2048)}).strict();
export class HostService {
  private configs:ProviderConfig[]=PROVIDERS.map(provider=>({provider,model:'',timeoutMs:30000}));
  private grants=new Map<string,number>();
  private epochs=new Map<string,number>();
  private bindings=new Map<string,Binding>();
  private calls=new Map<string,Set<AbortController>>();
  private verified=new Set<string>();
  private mutations:Promise<unknown>=Promise.resolve();
  constructor(readonly vault:Vault,private directory:string){}
  async load(){try{const saved=z.array(configSchema).parse(JSON.parse(await readFile(path.join(this.directory,'settings.json'),'utf8')));this.configs=this.configs.map(c=>saved.find(s=>s.provider===c.provider)??c);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')process.stderr.write('Settings unreadable; using empty defaults.\n');}}
  private key(profile:string,session:string){return profile+':'+session;}
  private locked(profile:string){return this.vault.locked||(this.grants.get(profile)??0)<Date.now();}
  private requireUnlocked(profile:string){if(this.locked(profile))throw new PilotError('vault_locked');this.grants.set(profile,Date.now()+600000);}
  cancel(profile:string,session:string){for(const c of this.calls.get(this.key(profile,session))??[])c.abort();}
  releaseSession(profile:string,session:string){this.cancel(profile,session);this.bindings.delete(this.key(profile,session));}
  releaseProfile(profile:string){
    this.epochs.set(profile,(this.epochs.get(profile)??0)+1);
    for(const key of this.calls.keys())if(key.startsWith(profile+':'))for(const c of this.calls.get(key)!)c.abort();
    for(const key of this.bindings.keys())if(key.startsWith(profile+':'))this.bindings.delete(key);
    this.grants.delete(profile);if(!this.grants.size)this.vault.lock();
  }
  private status(profile:string){
    const locked=this.locked(profile),keys=locked?[]:this.vault.list(profile).filter(e=>e.kind==='provider').map(e=>e.provider);
    return {host:HOST_NAME,protocol:PROTOCOL_VERSION,version:'0.2.0',locked,configs:this.configs,
      providers:this.configs.map(c=>({provider:c.provider,state:c.provider==='openai-decisions'?'preview_unavailable':locked?'vault_locked':!keys.includes(c.provider)?'missing_api_key':!c.model?'missing_model':this.verified.has(profile+':'+c.provider)?'verified_session':'configured_unverified'}))};
  }
  handle(profile:string,session:string,command:string,payload:any):Promise<any>{
    const epoch=this.epochs.get(profile)??0;
    const run=()=>{if((this.epochs.get(profile)??0)!==epoch)throw new PilotError('profile_disconnected');return this.run(profile,session,command,payload,epoch);};
    if(['configure','bind','vault.unlock','vault.lock','vault.put','vault.remove','vault.scope'].includes(command)){
      const operation=this.mutations.then(run);this.mutations=operation.catch(()=>{});return operation;
    }
    return run();
  }
  private async run(profile:string,session:string,command:string,payload:any,epoch:number):Promise<any>{
    const key=this.key(profile,session);
    switch(command){
      case 'status':return this.status(profile);
      case 'configure':{
        const config=configSchema.parse(payload),next=this.configs.map(c=>c.provider===config.provider?config:c);
        await atomicWrite(path.join(this.directory,'settings.json'),JSON.stringify(next));this.configs=next;this.verified.clear();return this.status(profile);
      }
      case 'bind':{const binding=bindingSchema.parse(payload);binding.origin=exactOrigin(binding.origin);this.cancel(profile,session);this.bindings.set(key,binding);return {bound:true};}
      case 'release':this.releaseSession(profile,session);return {released:true};
      case 'cancel':this.cancel(profile,session);return {cancelled:true};
      case 'vault.unlock':{
        try{await this.vault.unlock();}catch(error){if((this.epochs.get(profile)??0)!==epoch)throw new PilotError('profile_disconnected');throw error;}
        if((this.epochs.get(profile)??0)!==epoch){if(!this.grants.size)this.vault.lock();throw new PilotError('profile_disconnected');}
        this.grants.set(profile,Date.now()+600000);return {...this.status(profile),entries:this.vault.list(profile)};
      }
      case 'vault.lock':{
        for(const [key,calls] of this.calls)if(key.startsWith(profile+':'))for(const controller of calls)controller.abort();
        this.grants.delete(profile);if(!this.grants.size)this.vault.lock();return this.status(profile);
      }
      case 'vault.list':this.requireUnlocked(profile);return this.vault.list(profile);
      case 'vault.put':this.requireUnlocked(profile);await this.vault.put(vaultEntrySchema.parse(payload),profile);this.verified.clear();return {...this.status(profile),entries:this.vault.list(profile)};
      case 'vault.remove':this.requireUnlocked(profile);await this.vault.remove(idSchema.parse(payload?.id),profile);this.verified.clear();return this.vault.list(profile);
      case 'vault.scope':this.requireUnlocked(profile);await this.vault.rescope(idSchema.parse(payload?.id),secretScopeSchema.parse(payload?.scope),profile);this.verified.clear();return this.vault.list(profile);
      case 'credential.use':{
        this.requireUnlocked(profile);
        const p=z.object({id:idSchema,binding:bindingSchema}).strict().parse(payload),binding=this.bindings.get(key);
        if(!binding||binding.tabId!==p.binding.tabId||binding.documentId!==p.binding.documentId||binding.origin!==p.binding.origin)throw new PilotError('stale_binding');
        return this.vault.websiteSecret(p.id,binding.origin,profile);
      }
      case 'decide':{
        const p=z.object({provider:providerId,request:requestSchema}).strict().parse(payload),config=this.configs.find(c=>c.provider===p.provider)!;
        if(p.provider==='openai-decisions')return {requestId:p.request.requestId,stateVersion:p.request.stateVersion,provider:p.provider,model:'',latencyMs:0,status:'failed',code:'decisions_preview_unavailable'};
        this.requireUnlocked(profile);const secret=this.vault.providerSecret(p.provider,profile);
        const request={...p.request,question:this.vault.redact(p.request.question),context:this.vault.redact(p.request.context),choices:p.request.choices.map(c=>({...c,description:this.vault.redact(c.description)}))};
        const controller=new AbortController(),calls=this.calls.get(key)??new Set();calls.add(controller);this.calls.set(key,calls);
        try{const result=await decide(config,request,secret,this.directory,controller.signal);if(result.status==='selected')this.verified.add(profile+':'+p.provider);return result;}
        finally{calls.delete(controller);if(!calls.size)this.calls.delete(key);}
      }
      default:throw new PilotError('unknown_command');
    }
  }
}
