import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { imageDecisionCapability, PROVIDERS, HOST_NAME, PROTOCOL_VERSION, PilotError, configSchema,providerCatalogSchema,providerConfigureSchema, providerId, requestSchema, vaultEntrySchema, idSchema, secretScopeSchema, exactOrigin, type ProviderConfig, type Binding } from '../shared.js';
import { Vault, atomicWrite } from './vault.js';
import { DecisionPool } from './providers.js';
import {providerCatalog,type ProviderCatalog} from './provider-catalog.js';
import {exportData} from './export-policy.js';
import {buildInfo} from '../build-info.js';
import {passwordPrepareSchema,passwordFillSchema,passwordResumeSchema,passwordResolveSchema} from '../password-contract.js';
import {VaultSessionGrants} from './vault-session.js';

const bindingSchema=z.object({tabId:z.number().int().nonnegative(),documentId:z.string().min(1).max(100),origin:z.string().max(2048)}).strict();
export class HostService {
  private configs:ProviderConfig[]=PROVIDERS.map(provider=>({provider,model:'',timeoutMs:30000,connection:provider==='codex-sdk'||provider==='claude-sdk'?'sdk':'environment'}));
  private catalogs=new Map<string,{expires:number;value:ProviderCatalog}>();
  private grants=new Set<string>();
  private epochs=new Map<string,number>();
  private bindings=new Map<string,Binding>();
  private calls=new Map<string,Set<AbortController>>();
  private verified=new Set<string>();
  private mutations:Promise<unknown>=Promise.resolve();
  private pool:DecisionPool;
  constructor(readonly vault:Vault,private directory:string,private beforeConfigure:()=>Promise<void>=async()=>{},private vaultSession?:VaultSessionGrants){this.pool=new DecisionPool(directory);}
  async close(){this.invalidateDecisions();await this.pool.close();await this.mutations;this.grants.clear();this.vault.lock();}
  private invalidateDecisions(){for(const calls of this.calls.values())for(const c of calls)c.abort();this.pool.invalidate();}
  invalidateProfileDecisions(profile:string){
    this.pool.invalidate(profile+':');
    for(const [key,calls] of this.calls)if(key.startsWith(profile+':'))for(const c of calls)c.abort();
    for(const key of this.bindings.keys())if(key.startsWith(profile+':'))this.bindings.delete(key);
  }
  async load(){try{const saved=z.array(configSchema).parse(JSON.parse(await readFile(path.join(this.directory,'settings.json'),'utf8')));this.configs=this.configs.map(c=>saved.find(s=>s.provider===c.provider)??c);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')process.stderr.write('Settings unreadable; using empty defaults.\n');}}
  private key(profile:string,session:string){return profile+':'+session;}
  private locked(profile:string){return this.vault.locked||!this.grants.has(profile);}
  private requireUnlocked(profile:string){if(this.locked(profile))throw new PilotError('vault_locked');}
  private revokeGrant(profile:string){this.grants.delete(profile);if(!this.grants.size)this.vault.lock();}
  revokeProfileUnlock(profile:string){
    const operation=this.mutations.then(async()=>{await this.vaultSession?.revoke(profile);this.revokeGrant(profile);});
    this.mutations=operation.catch(()=>{});return operation;
  }
  restoreProfileUnlock(profile:string,assertActive:()=>void=()=>{}){
    const epoch=this.epochs.get(profile)??0;
    const operation=this.mutations.then(async()=>{
      if(!this.vaultSession||!await this.vaultSession.allowed(profile))return false;
      const active=()=>{assertActive();if((this.epochs.get(profile)??0)!==epoch)throw new PilotError('profile_disconnected');};
      try{active();await this.vault.unlock();active();this.grants.add(profile);return true;}
      catch{if(!this.grants.size)this.vault.lock();return false;}
    });this.mutations=operation.catch(()=>{});return operation;
  }
  cancel(profile:string,session:string){for(const c of this.calls.get(this.key(profile,session))??[])c.abort();}
  releaseSession(profile:string,session:string){this.cancel(profile,session);this.pool.invalidate(this.key(profile,session)+':');this.bindings.delete(this.key(profile,session));}
  releaseProfile(profile:string){
    this.epochs.set(profile,(this.epochs.get(profile)??0)+1);
    this.pool.invalidate(profile+':');
    for(const key of this.catalogs.keys())if(key.startsWith(profile+':'))this.catalogs.delete(key);
    for(const key of this.calls.keys())if(key.startsWith(profile+':'))for(const c of this.calls.get(key)!)c.abort();
    for(const key of this.bindings.keys())if(key.startsWith(profile+':'))this.bindings.delete(key);
    this.revokeGrant(profile);
  }
  private status(profile:string){
    const locked=this.locked(profile),keys=locked?[]:this.vault.list(profile).filter(e=>e.kind==='provider').map(e=>e.provider);
    return {host:HOST_NAME,protocol:PROTOCOL_VERSION,version:buildInfo.version,build:buildInfo,actionDiagnosticVersion:2,locked,vaultUnlockLifetime:this.vaultSession?'windows_session':'host_process',configs:this.configs,
      providers:this.configs.map(c=>({provider:c.provider,state:c.provider==='openai-decisions'?'preview_unavailable':c.connection==='sdk'?'sdk_available':c.connection==='environment'?this.environmentKey(c.provider)?'configured_unverified':'missing_api_key':locked?'vault_locked':!keys.includes(c.provider)?'missing_api_key':!c.model?'missing_model':this.verified.has(profile+':'+c.provider)?'verified_session':'configured_unverified'}))};
  }
  private environmentKey(provider:string){return provider==='typesafe-jev'?process.env.TYPESAFE_API_KEY??process.env.JEV_API_KEY:undefined;}
  private validateConnection(config:ProviderConfig){
    if(config.connection==='sdk'&&!['codex-sdk','claude-sdk'].includes(config.provider)||config.connection==='environment'&&!['typesafe-jev','openai-decisions'].includes(config.provider))throw new PilotError('invalid_connection');
  }
  handle(profile:string,session:string,command:string,payload:any,vaultEnabled=true,assertActive:()=>void=()=>{}):Promise<any>{
    const epoch=this.epochs.get(profile)??0;
    const run=async()=>{assertActive();if((this.epochs.get(profile)??0)!==epoch)throw new PilotError('profile_disconnected');const value=await this.run(profile,session,command,payload,epoch,vaultEnabled,assertActive);if(command.startsWith('password.')){assertActive();if((this.epochs.get(profile)??0)!==epoch)throw new PilotError('profile_disconnected');this.requireUnlocked(profile);}return value;};
    if(command.startsWith('password.')||['configure','provider.configure','bind','vault.unlock','vault.lock','vault.put','vault.remove','vault.scope'].includes(command)){
      const operation=this.mutations.then(run);this.mutations=operation.catch(()=>{});return operation;
    }
    return run();
  }
  private async run(profile:string,session:string,command:string,payload:any,epoch:number,vaultEnabled:boolean,assertActive:()=>void=()=>{}):Promise<any>{
    if(!vaultEnabled&&(command.startsWith('password.')||command.startsWith('vault.')&&command!=='vault.lock'||command==='credential.use'))throw new PilotError('vault_disabled');
    const key=this.key(profile,session);
    switch(command){
      case 'status':return this.status(profile);
      case 'provider.catalog':{
        const p=providerCatalogSchema.parse(payload);
        const config={...this.configs.find(c=>c.provider===p.provider)!,...(p.connection?{connection:p.connection}:{})};
        this.validateConnection(config);
        if(config.connection==='vault'&&!vaultEnabled)throw new PilotError('vault_disabled');
        if(config.connection==='vault')this.requireUnlocked(profile);
        const cacheKey=profile+':'+p.provider+':'+config.connection,cached=this.catalogs.get(cacheKey);if(!p.refresh&&cached&&cached.expires>Date.now())return cached.value;
        let secret:string|undefined;if(config.connection==='vault'){this.requireUnlocked(profile);secret=this.vault.providerSecret(p.provider,profile);}else if(config.connection==='environment')secret=this.environmentKey(p.provider);
        const value=await providerCatalog(config,this.directory,secret);this.catalogs.set(cacheKey,{expires:Date.now()+300000,value});return value;
      }
      case 'configure':{
        const config=configSchema.parse(payload);this.validateConnection(config);const next=this.configs.map(c=>c.provider===config.provider?config:c);
        assertActive();await this.beforeConfigure();assertActive();if((this.epochs.get(profile)??0)!==epoch)throw new PilotError('profile_disconnected');
        this.invalidateDecisions();await atomicWrite(path.join(this.directory,'settings.json'),JSON.stringify(next));this.configs=next;this.verified.clear();this.catalogs.clear();return this.status(profile);
      }
      case 'provider.configure':{
        const {settingsScope,...input}=providerConfigureSchema.parse(payload);
        const current=this.configs.find(c=>c.provider===input.provider)!;
        const config={...input,connection:input.connection??current.connection};
        const catalog:ProviderCatalog=await this.run(profile,session,'provider.catalog',{provider:config.provider,connection:config.connection},epoch,vaultEnabled,assertActive);
        assertActive();
        if(catalog.state!=='connected')throw new PilotError(catalog.state==='preview_unavailable'?'decisions_preview_unavailable':catalog.state==='missing_api_key'?'missing_api_key':catalog.state==='login_required'?'login_required':'provider_not_connected');
        if(!catalog.models.some(model=>model.id===config.model))throw new PilotError('model_not_available');
        if((this.epochs.get(profile)??0)!==epoch)throw new PilotError('profile_disconnected');
        if(config.provider===current.provider&&config.model===current.model&&config.connection===current.connection&&config.timeoutMs===current.timeoutMs)return this.status(profile);
        return this.run(profile,session,'configure',config,epoch,vaultEnabled,assertActive);
      }
      case 'bind':{const binding=bindingSchema.parse(payload);binding.origin=exactOrigin(binding.origin);this.cancel(profile,session);this.bindings.set(key,binding);return {bound:true};}
      case 'release':this.releaseSession(profile,session);return {released:true};
      case 'cancel':this.cancel(profile,session);return {cancelled:true};
      case 'vault.unlock':{
        const active=()=>{assertActive();if((this.epochs.get(profile)??0)!==epoch)throw new PilotError('profile_disconnected');};
        try{await this.vault.unlock();active();await this.vaultSession?.remember(profile,active);active();}
        catch(error){if(!this.grants.size)this.vault.lock();if((this.epochs.get(profile)??0)!==epoch)throw new PilotError('profile_disconnected');throw error;}
        this.grants.add(profile);return {...this.status(profile),entries:this.vault.list(profile)};
      }
      case 'vault.lock':{
        await this.vaultSession?.revoke(profile);
        this.pool.invalidate(profile+':');
        for(const [key,calls] of this.calls)if(key.startsWith(profile+':'))for(const controller of calls)controller.abort();
        this.revokeGrant(profile);return this.status(profile);
      }
      case 'vault.list':this.requireUnlocked(profile);return this.vault.list(profile);
      case 'password.list':this.requireUnlocked(profile);return this.vault.passwordChanges(profile);
      case 'password.prepare':case 'password.resume':case 'password.begin':case 'password.filled':case 'password.resolve':{
        this.requireUnlocked(profile);
        const {binding:submitted,...input}=z.object({binding:bindingSchema}).passthrough().parse(payload),binding=this.bindings.get(key);
        if(!binding||binding.tabId!==submitted.tabId||binding.documentId!==submitted.documentId||binding.origin!==exactOrigin(submitted.origin,true))throw new PilotError('stale_binding');
        const active=()=>{assertActive();if((this.epochs.get(profile)??0)!==epoch||this.bindings.get(key)!==binding)throw new PilotError('stale_binding');this.requireUnlocked(profile);};
        if(command==='password.prepare')return this.vault.preparePassword(passwordPrepareSchema.parse(input),profile,session,binding,active);
        if(command==='password.resume'){const p=passwordResumeSchema.parse(input);return this.vault.resumePassword(p.changeId,profile,session,binding,p.refillAfterInspection,active);}
        if(command==='password.begin'){const p=passwordFillSchema.parse(input);return this.vault.beginPasswordFill(p.changeId,profile,session,binding,!!p.currentPasswordTargetId,active);}
        if(command==='password.filled')return this.vault.passwordFilled(idSchema.parse(input.changeId),profile,session,binding,active);
        const p=passwordResolveSchema.parse(input);return this.vault.resolvePassword(p.changeId,profile,session,binding.origin,p.outcome,p.confirmation,active);
      }
      case 'vault.put':this.requireUnlocked(profile);this.invalidateDecisions();await this.vault.put(vaultEntrySchema.parse(payload),profile);this.verified.clear();this.catalogs.clear();return {...this.status(profile),entries:this.vault.list(profile)};
      case 'vault.remove':this.requireUnlocked(profile);this.invalidateDecisions();await this.vault.remove(idSchema.parse(payload?.id),profile);this.verified.clear();this.catalogs.clear();return this.vault.list(profile);
      case 'vault.scope':this.requireUnlocked(profile);this.invalidateDecisions();await this.vault.rescope(idSchema.parse(payload?.id),secretScopeSchema.parse(payload?.scope),profile);this.verified.clear();this.catalogs.clear();return this.vault.list(profile);
      case 'credential.use':{
        this.requireUnlocked(profile);
        const p=z.object({id:idSchema,binding:bindingSchema}).strict().parse(payload),binding=this.bindings.get(key);
        if(!binding||binding.tabId!==p.binding.tabId||binding.documentId!==p.binding.documentId||binding.origin!==p.binding.origin)throw new PilotError('stale_binding');
        return this.vault.websiteSecret(p.id,binding.origin,profile);
      }
      case 'decide':{
        const p=z.object({provider:providerId,request:requestSchema}).strict().parse(payload),config=this.configs.find(c=>c.provider===p.provider)!;
        if(p.request.images?.length&&imageDecisionCapability(config).status!=='available')throw new PilotError('provider_vision_unsupported');
        if(p.request.images?.some(image=>image.expiresAt<Date.now()))throw new PilotError('stale_capture');
        if(p.provider==='openai-decisions')return {requestId:p.request.requestId,stateVersion:p.request.stateVersion,provider:p.provider,model:'',latencyMs:0,status:'failed',code:'decisions_preview_unavailable'};
        let secret='';if(config.connection==='sdk'){if(!['codex-sdk','claude-sdk'].includes(p.provider))throw new PilotError('invalid_connection');}
        else if(config.connection==='environment'){secret=this.environmentKey(p.provider)??'';if(!secret)throw new PilotError('missing_api_key');}
        else {if(!vaultEnabled)throw new PilotError('vault_disabled');this.requireUnlocked(profile);secret=this.vault.providerSecret(p.provider,profile);}
        const redact=(value:any)=>exportData(value,item=>this.vault.locked?item:this.vault.redact(item));
        const request={...p.request,question:redact(p.request.question),context:redact(p.request.context),choices:p.request.choices.map(c=>({...c,description:redact(c.description)}))};
        const controller=new AbortController(),calls=this.calls.get(key)??new Set();calls.add(controller);this.calls.set(key,calls);
        try{const result=await this.pool.decide(key+':'+p.provider,config,request,secret,controller.signal);if(controller.signal.aborted||(this.epochs.get(profile)??0)!==epoch)throw new PilotError('cancelled');if(result.status==='selected')this.verified.add(profile+':'+p.provider);return result;}
        finally{calls.delete(controller);if(!calls.size)this.calls.delete(key);}
      }
      default:throw new PilotError('unknown_command');
    }
  }
}
