import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash, generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);
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
  permissions: ['activeTab', 'tabs', 'tabGroups', 'scripting', 'nativeMessaging', 'storage', 'sidePanel'],
  host_permissions: ['http://*/*', 'https://*/*'],
  background: { service_worker: 'background.js', type: 'module' },
  action: { default_title: 'Tabora Browser' },
  side_panel: { default_path: 'panel.html' },
  options_page: 'panel.html',
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; connect-src 'none'; base-uri 'none'" },
}, null, 2));
await build({ entryPoints: ['src/extension/background.ts','src/extension/panel.ts'], outdir:'dist/extension', bundle:true, format:'esm', platform:'browser', target:'chrome116', sourcemap:true });
await build({ entryPoints: ['src/host/main.ts','src/host/broker.ts','src/host/mcp.ts','src/host/provider-worker.ts'], outdir:'dist/host', bundle:true, packages:'external', format:'esm', platform:'node', target:'node22', sourcemap:true });
for (const file of ['panel.html','panel.css']) await copyFile('src/extension/'+file,'dist/extension/'+file);
await copyFile('scripts/dpapi.ps1','dist/host/dpapi.ps1');
await writeFile('mcp.config.json',JSON.stringify({mcpServers:{'tabora-browser':{command:process.execPath,args:[path.join(root,'dist/host/mcp.js')],...(process.env.TABORA_STATE_DIR?{env:{TABORA_STATE_DIR:process.env.TABORA_STATE_DIR}}:{})}}},null,2)+'\n');
console.log('Built extension: ' + extensionId);
