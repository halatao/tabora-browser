import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { root } from './setup-lib.mjs';

const requireProfile = process.argv.includes('--require-profile');
if (process.platform !== 'win32') throw new Error('Windows is required for the native host and DPAPI vault.');
const manifest = JSON.parse(await readFile(path.join(root, 'dist/native-host/com.tabora.browser.json'), 'utf8'));
const id = (await readFile(path.join(root, 'extension-id.txt'), 'utf8')).trim();
if (manifest.allowed_origins?.[0] !== `chrome-extension://${id}/`) throw new Error('Native manifest has the wrong extension ID. Run setup again.');
for (const browser of ['Google\\Chrome', 'Microsoft\\Edge', 'Chromium']) {
  const output = execFileSync('reg.exe', ['query', `HKCU\\Software\\${browser}\\NativeMessagingHosts\\com.tabora.browser`, '/ve'], { encoding: 'utf8', windowsHide: true });
  if (!output.toLowerCase().includes(path.join(root, 'dist/native-host/com.tabora.browser.json').toLowerCase())) throw new Error(`Native registration points to another checkout: ${browser}`);
}
const client = new Client({ name: 'tabora-doctor', version: '1.0.0' });
const timer = setTimeout(() => { console.error('MCP health check timed out.'); process.exit(1); }, 30000);
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/host/mcp.js')], env: process.env, stderr: 'pipe' }));
  const tools = (await client.listTools()).tools;
  if (tools.length !== 48 || !tools.some(t=>t.name==='browser_upload') || !tools.some(t=>t.name==='browser_provider_configure')) throw new Error('Unexpected MCP tool contract.');
  const response = await client.callTool({ name: 'browser_profiles', arguments: {} });
  if (response.isError) throw new Error('MCP profile discovery failed.');
  const profiles = JSON.parse(response.content.find(x => x.type === 'text').text);
  console.log(JSON.stringify({ nativeHost: 'ok', mcp: 'ok', tools: tools.length, profiles: profiles.map(p => ({ id: p.id, name: p.name })) }, null, 2));
  if (!profiles.length) {
    if (requireProfile) throw new Error('No MCP-enabled browser profile connected.');
    console.log('No enabled profile yet. Start a managed browser or load the extension and enable MCP.');
  }
} finally { await client.close(); clearTimeout(timer); }
