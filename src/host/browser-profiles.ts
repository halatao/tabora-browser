import path from 'node:path';
import {readFile,stat} from 'node:fs/promises';
import {z} from 'zod';
export interface ProfileCandidate {key:string;name:string;installed:boolean;}
export function chooseBrowserProfile(candidates:ProfileCandidate[],key?:string){
  const selected=key?candidates.find(c=>c.key===key):undefined;
  if(selected)return selected;
  const installed=candidates.filter(c=>c.installed);
  return installed.length===1?installed[0]:candidates.length===1?candidates[0]:undefined;
}
async function metadata(file:string){
  try{if((await stat(file)).size>10*1024*1024)return undefined;return JSON.parse(await readFile(file,'utf8'));}catch{return undefined;}
}
export async function detectBrowserProfiles(input:unknown){
  const p=z.object({browser:z.enum(['chrome','edge']),key:z.string().max(160).optional()}).strict().parse(input);
  const managed=z.string().trim().min(1).max(80).safeParse(process.env.TABORA_BROWSER_NAME);
  if(managed.success){const candidate={key:'managed:'+managed.data,name:managed.data,installed:true};return {candidates:[candidate],automatic:candidate};}
  const root=path.join(process.env.LOCALAPPDATA??'',p.browser==='edge'?'Microsoft/Edge/User Data':'Google/Chrome/User Data');
  const state=await metadata(path.join(root,'Local State'));
  const extensionId=(await readFile(path.join(import.meta.dirname,'../../extension-id.txt'),'utf8')).trim();
  const candidates:ProfileCandidate[]=[];
  for(const [directory,raw] of Object.entries(state?.profile?.info_cache??{}).slice(0,40)){
    if(!/^(Default|Profile \d+)$/.test(directory))continue;
    const name=z.object({name:z.string().trim().min(1).max(80)}).safeParse(raw);if(!name.success)continue;
    const secure=await metadata(path.join(root,directory,'Secure Preferences'));
    candidates.push({key:p.browser+':'+directory,name:name.data.name,installed:Boolean(secure?.extensions?.settings?.[extensionId])});
  }
  return {candidates,automatic:chooseBrowserProfile(candidates,p.key)};
}
