import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import { createHash, generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);
const version=JSON.parse(await readFile('package.json','utf8')).version;
const hash=createHash('sha256');
async function fingerprint(directory){
  for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    const file=path.join(directory,entry.name);
    if(entry.isDirectory())await fingerprint(file);
    else if(entry.isFile()){hash.update(file.replaceAll('\\','/'));hash.update('\0');hash.update(await readFile(file));hash.update('\0');}
  }
}
await fingerprint('src');
for(const file of ['package.json','package-lock.json','scripts/build.mjs','tsconfig.json']){hash.update(file);hash.update(await readFile(file));}
const buildInfo={version,fingerprint:hash.digest('hex'),contractVersion:2};
const define={__TABORA_BUILD__:JSON.stringify(buildInfo)};
await mkdir('dist/extension', { recursive: true });
await mkdir('dist/host', { recursive: true });
let key;
try { key = (await readFile('extension-key.txt', 'utf8')).trim(); }
catch (e) {
  if (e.code !== 'ENOENT') throw e;
  key = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({type:'spki',format:'der'}).toString('base64');
  await writeFile('extension-key.txt', key + '\n');
}
const extensionId = [...createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16)].map(b=>String.fromCharCode(97+(b>>4),97+(b&15))).join('');
await writeFile('extension-id.txt', extensionId + '\n');
await writeFile('dist/extension/manifest.json', JSON.stringify({
  manifest_version: 3, name: 'Tabora Browser', version: JSON.parse(await readFile('package.json','utf8')).version, key,
  description: 'Local browser control for AI agents, with MCP and an optional encrypted vault.',
  minimum_chrome_version: '116',
  icons: { '128': 'icon.png' },
  // Chrome does not allow debugger as an optional permission. Core browser
  // control permissions are approved together when the extension is installed.
  permissions: ['activeTab', 'tabs', 'tabGroups', 'scripting', 'nativeMessaging', 'storage', 'sidePanel','webNavigation','debugger','downloads'],
  optional_permissions:[],
  host_permissions: ['http://*/*', 'https://*/*'],
  background: { service_worker: 'background.js', type: 'module' },
  action: { default_title: 'Tabora Browser', default_icon: 'icon.png' },
  side_panel: { default_path: 'panel.html' },
  options_page: 'panel.html?tools',
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; connect-src 'none'; base-uri 'none'" },
}, null, 2));
await build({ define, entryPoints: ['src/extension/background.ts','src/extension/panel.ts'], outdir:'dist/extension', bundle:true, format:'esm', platform:'browser', target:'chrome116', sourcemap:true });
await build({entryPoints:['src/extension/sensor.ts'],outdir:'dist/extension',bundle:true,format:'iife',platform:'browser',target:'chrome116',sourcemap:true});
await build({ define, entryPoints: ['src/host/main.ts','src/host/broker.ts','src/host/mcp.ts','src/host/provider-worker.ts','src/host/document-worker.ts'], outdir:'dist/host', bundle:true, packages:'external', format:'esm', platform:'node', target:'node22', sourcemap:true });
await writeFile('dist/build-info.json',JSON.stringify(buildInfo,null,2)+'\n');
for (const file of ['panel.html','panel.css','icon.png']) await copyFile('src/extension/'+file,'dist/extension/'+file);
await copyFile('scripts/dpapi.ps1','dist/host/dpapi.ps1');
await writeFile('mcp.config.json',JSON.stringify({mcpServers:{'tabora-browser':{command:process.execPath,args:[path.join(root,'dist/host/mcp.js')],env:{TABORA_FILE_ROOTS:process.env.TABORA_FILE_ROOTS??JSON.stringify([root]),...(process.env.TABORA_STATE_DIR?{TABORA_STATE_DIR:process.env.TABORA_STATE_DIR}:{})}}}},null,2)+'\n');
console.log('Built extension: ' + extensionId);
