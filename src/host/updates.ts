import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';

const repository='https://github.com/halatao/tabora-browser';
const versionSchema=z.string().regex(/^\d+\.\d+\.\d+$/).max(40);
const cacheSchema=z.object({checkedAt:z.number().nonnegative(),latestVersion:versionSchema,source:z.enum(['release','main','preview-release']),releaseTag:z.string().max(80).optional()}).strict();
type Build={version:string;fingerprint:string;contractVersion:number};
export function newerVersion(candidate:string,current:string){
  if(!versionSchema.safeParse(candidate).success||!versionSchema.safeParse(current).success)return false;
  const a=candidate.split('.').map(Number),b=current.split('.').map(Number);
  for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i];}return false;
}
export const updateSteps=[
  'Finish or cancel active Tabora tasks; verify any write whose outcome is unknown before retrying it.',
  'In the installed checkout, inspect git status. Preserve local changes; do not reset or overwrite them. Stop managed profiles before updating.',
  'Run git pull --ff-only, then powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1 -Client auto. For a non-Git installation, download the published version and follow the README instead.',
  'Reload Tabora at chrome://extensions or edge://extensions in each ordinary profile and complete browser consent if requested. Restart managed profiles with their existing configuration.',
  'Reconnect the MCP client, call browser_capabilities in a new owned session, and confirm compatible=true and sameBuild=true before continuing.',
  'If sameBuild stays false, an older shared broker may still be serving another profile. Finish all tasks, temporarily disable Tabora in every connected browser profile and stop its MCP clients, wait for the idle broker to exit, then re-enable/reload Tabora and reconnect. Keep ordinary tabs open; do not kill unrelated Chrome or Node processes.',
];

/** Fetches version metadata only. Remote release text, scripts and assets are never executed. */
export class UpdateChecker{
  private cached?:z.infer<typeof cacheSchema>;
  private loaded=false;private attemptedAt?:number;private failure?:string;
  private pending?:Promise<ReturnType<UpdateChecker['status']>>;
  private variants=new Map<'stable'|'preview',UpdateChecker>();
  constructor(private build:Build,private directory?:string,private request:typeof fetch=fetch,private now=Date.now,private channel:'stable'|'preview'='stable'){}
  forChannel(channel:'stable'|'preview'){
    if(channel===this.channel)return this;let checker=this.variants.get(channel);
    if(!checker){checker=new UpdateChecker(this.build,this.directory,this.request,this.now,channel);this.variants.set(channel,checker);}return checker;
  }
  private cacheName(){return this.channel==='preview'?'update-check-preview.json':'update-check.json';}
  private status(){return {status:this.failure?'unavailable':this.cached?newerVersion(this.cached.latestVersion,this.build.version)?'update_available':'up_to_date':'not_checked',installed:this.build,channel:this.channel,latestVersion:this.cached?.latestVersion,releaseTag:this.cached?.releaseTag,checkedAt:this.cached?.checkedAt,source:this.cached?.source,stale:!!this.cached&&this.now()-this.cached.checkedAt>=6*60*60*1000,code:this.failure,repository,guide:repository+'/blob/main/docs/updates.md',steps:updateSteps,automaticInstallation:false};}
  async check(force=false){
    if(process.env.TABORA_UPDATE_CHECK==='0')return {...this.status(),status:'disabled'};
    if(this.pending)return this.pending;
    this.pending=this.perform(force).finally(()=>{this.pending=undefined;});return this.pending;
  }
  private async metadata(url:string,maximum=32768){
    const response=await this.request(url,{signal:AbortSignal.timeout(4000),redirect:'error',headers:{Accept:'application/json','User-Agent':'tabora-browser-update-check'}});
    if(response.status===404)return undefined;
    if(!response.ok||Number(response.headers.get('content-length')??0)>maximum)throw new Error('update_check_failed');
    const reader=response.body?.getReader();if(!reader)throw new Error('update_check_failed');
    let size=0;const chunks:Uint8Array[]=[];
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum)throw new Error('update_metadata_too_large');chunks.push(value);}}
    finally{await reader.cancel().catch(()=>{});}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  private async perform(force:boolean){
    if(!this.loaded){this.loaded=true;if(this.directory)try{const file=await readFile(path.join(this.directory,this.cacheName()),'utf8');if(file.length<=32768)this.cached=cacheSchema.parse(JSON.parse(file));}catch{/* A missing or invalid advisory cache never blocks browser use. */}}
    if(!force&&(this.cached&&this.now()-this.cached.checkedAt<6*60*60*1000||this.attemptedAt!==undefined&&this.now()-this.attemptedAt<30*60*1000))return this.status();
    this.attemptedAt=this.now();
    try{
      let release:any;
      if(this.channel==='preview'){
        const list=z.array(z.object({tag_name:z.string().max(80),draft:z.boolean(),prerelease:z.boolean()})).max(10).parse(await this.metadata('https://api.github.com/repos/halatao/tabora-browser/releases?per_page=10',262144));
        for(const candidate of list){
          const version=candidate.tag_name.replace(/^(?:preview-)?v/,'');
          if(candidate.draft||!versionSchema.safeParse(version).success||candidate.tag_name!==(candidate.prerelease?'preview-v':'v')+version)continue;
          if(!release||newerVersion(version,release.tag_name.replace(/^(?:preview-)?v/,'')))release=candidate;
        }
      }else release=await this.metadata('https://api.github.com/repos/halatao/tabora-browser/releases/latest');
      let latestVersion:string,source:'release'|'main'|'preview-release',releaseTag:string|undefined;
      if(release){const parsed=z.object({tag_name:z.string().max(80),draft:z.literal(false),prerelease:z.boolean()}).parse(release);if(parsed.prerelease&&this.channel!=='preview')throw new Error('invalid_release_channel');latestVersion=versionSchema.parse(parsed.tag_name.replace(/^(?:preview-)?v/,''));if(parsed.tag_name!==(parsed.prerelease?'preview-v':'v')+latestVersion)throw new Error('invalid_release_channel');source=parsed.prerelease?'preview-release':'release';releaseTag=parsed.tag_name;}
      else{const manifest=await this.metadata('https://raw.githubusercontent.com/halatao/tabora-browser/main/package.json');latestVersion=z.object({version:versionSchema}).parse(manifest).version;source='main';}
      this.cached={checkedAt:this.now(),latestVersion,source,...(releaseTag?{releaseTag}:{})};this.failure=undefined;
      if(this.directory)try{await mkdir(this.directory,{recursive:true});const temporary=path.join(this.directory,this.cacheName()+'.'+process.pid+'.tmp');await writeFile(temporary,JSON.stringify(this.cached),{mode:0o600});await rename(temporary,path.join(this.directory,this.cacheName()));}catch{/* A cache-write failure does not invalidate fetched metadata. */}
    }catch{this.failure='update_check_failed';}
    const result=this.status();return this.failure?{...result,status:'unavailable'}:result;
  }
}
