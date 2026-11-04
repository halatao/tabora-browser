import path from 'node:path';
import {mkdir,readFile,writeFile,cp,copyFile,lstat,unlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createPublicKey} from 'node:crypto';
import {zip} from './distribution/archive.mjs';
import {hashFile} from './distribution/release.mjs';
import {files,mapBounded} from './distribution/files.mjs';
const root=path.resolve(import.meta.dirname,'..');
if(process.platform!=='win32'||process.arch!=='x64'||Number(process.versions.node.split('.')[0])<22)throw new Error('Packaging requires Windows x64 and Node 22+.');
const index=process.argv.indexOf('--out');
const output=path.resolve(index>=0?process.argv[index+1]:path.join(root,'release'));
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')),lock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8'));
if(!/^\d+\.\d+\.\d+$/.test(pkg.version))throw new Error('Invalid package version.');
const build=JSON.parse(await readFile(path.join(root,'dist/build-info.json'),'utf8'));
const channel=process.env.TABORA_RELEASE_CHANNEL??'stable';if(!['stable','preview'].includes(channel))throw new Error('Invalid release channel.');
if(pkg.version!==build.version)throw new Error('Build the current version before packaging.');
await mkdir(output,{recursive:true});
const payload=path.join(output,'payload'),refresh=process.argv.includes('--refresh');
if(refresh){if(await hashFile(path.join(payload,'package-lock.json'))!==await hashFile(path.join(root,'package-lock.json')))throw new Error('Dependency lock changed; use a fresh output directory.');}
else await mkdir(payload);
for(const directory of ['dist/host','dist/extension'])await cp(path.join(root,directory),path.join(payload,directory),{recursive:true});
await mkdir(path.join(payload,'runtime'),{recursive:true});await copyFile(process.execPath,path.join(payload,'runtime/node.exe'));
await copyFile(path.join(path.dirname(process.execPath),'LICENSE'),path.join(payload,'runtime/LICENSE'));
await copyFile(path.join(root,'dist/build-info.json'),path.join(payload,'dist/build-info.json'));
for(const file of ['package.json','package-lock.json','extension-key.txt','extension-id.txt','LICENSE'])await copyFile(path.join(root,file),path.join(payload,file));
await mkdir(path.join(payload,'scripts'),{recursive:true});
for(const file of ['cli.mjs','browser.mjs','close-managed.ps1','setup-lib.mjs','state-directory.mjs','physical-directory.ps1'])await copyFile(path.join(root,'scripts',file),path.join(payload,'scripts',file));
await cp(path.join(root,'scripts/distribution'),path.join(payload,'scripts/distribution'),{recursive:true});
const components=[];
for(const [relative,entry] of Object.entries(lock.packages)) {
  if(!relative||entry.dev&&!['node_modules/playwright','node_modules/playwright-core'].includes(relative))continue;
  const source=path.join(root,relative);
  try {await lstat(source);}catch(error){if(error.code==='ENOENT'&&entry.optional)continue;throw error;}
  if(!refresh){await mkdir(path.dirname(path.join(payload,relative)),{recursive:true});await cp(source,path.join(payload,relative),{recursive:true,filter:file=>path.basename(file)!=='node_modules'});}
  components.push({name:relative.replace(/^.*node_modules\//,''),version:entry.version,integrity:entry.integrity,license:entry.license});
}
// Bundled dependencies come from this exact installed lockfile, including optional native binaries.
await writeFile(path.join(payload,'sbom.json'),JSON.stringify({schema:1,node:process.version,components},null,2));
const trust=process.env.TABORA_RELEASE_TRUST?JSON.parse(process.env.TABORA_RELEASE_TRUST):JSON.parse(await readFile(path.join(root,'release-trust.json'),'utf8'));
if(trust.schema!==1||!Array.isArray(trust.keys))throw new Error('Invalid release trust.');
for(const key of trust.keys){if(createPublicKey(key.publicKey).asymmetricKeyType!=='ed25519'||key.publicKey.includes('PRIVATE'))throw new Error('Invalid release public key.');}
await writeFile(path.join(payload,'release-trust.json'),JSON.stringify(trust,null,2));
const compiler=path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
execFileSync(compiler,['/nologo','/target:exe','/reference:System.Web.Extensions.dll','/out:'+path.join(payload,'tabora.exe'),path.join(root,'scripts/distribution/Launcher.cs')],{stdio:'inherit',windowsHide:true});
const inventory=Object.fromEntries(await mapBounded((await files(payload)).filter(file=>file!=='package-info.json'),async relative=>[relative,await hashFile(path.join(payload,relative))]));
await writeFile(path.join(payload,'package-info.json'),JSON.stringify({schema:1,platform:process.platform,arch:process.arch,channel,node:process.version,versionId:build.version+'-'+build.fingerprint.slice(0,16),inventory},null,2));
const base='tabora-'+pkg.version;
if(refresh)for(const suffix of ['-windows-x64.zip','-extension.zip'])await unlink(path.join(output,base+suffix)).catch(error=>{if(error.code!=='ENOENT')throw error;});
await zip(payload,path.join(output,base+'-windows-x64.zip'));
await zip(path.join(root,'dist/extension'),path.join(output,base+'-extension.zip'));
await copyFile(path.join(payload,'sbom.json'),path.join(output,'sbom.json'));
await writeFile(path.join(output,'SHA256SUMS'),await Promise.all([base+'-windows-x64.zip',base+'-extension.zip'].map(async file=>`${await hashFile(path.join(output,file))}  ${file}\n`)).then(lines=>lines.join('')));
console.log(JSON.stringify({output,version:pkg.version,components:components.length,node:process.version,remoteTrustConfigured:trust.keys.length>0}));
