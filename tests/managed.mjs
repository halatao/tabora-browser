import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const exec = promisify(execFile), base = path.resolve('.test-state');
await mkdir(base, { recursive: true });
const directory = await mkdtemp(path.join(base, 'managed-'));
const env = { ...process.env, TABORA_STATE_DIR: directory };
let clicked = false;
const fixture = createServer((req, res) => {
  if (req.url === '/clicked') { clicked = true; res.end('ok'); return; }
  res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Tabora setup fixture</title><button onclick="fetch(\'/clicked\')">Continue</button>');
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const browser = (...args) => exec(process.execPath, ['scripts/browser.mjs', ...args], { env, windowsHide: true, timeout: 60000 });
const client = new Client({ name: 'tabora-setup-test', version: '1.0.0' });
async function tool(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const data = JSON.parse(result.content.find(x => x.type === 'text').text);
  assert(!result.isError, `${name}: ${JSON.stringify(data)}`); return data;
}
try {
  const first = JSON.parse((await browser('start', '--profile', 'test', '--headless', '--allow-origin', origin)).stdout);
  assert(first.ready && first.mcpEnabled);
  const again = JSON.parse((await browser('start', '--profile', 'test', '--headless')).stdout);
  assert.equal(first.profileId, again.profileId);
  await assert.rejects(browser('start', '--profile', 'test', '--allow-origin', 'https://example.com'));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/host/mcp.js')], env, stderr: 'pipe' }));
  const profiles = await tool('browser_profiles'); assert.equal(profiles.length, 1); assert.equal(profiles[0].id, first.profileId);
  const session = await tool('browser_session_create', { profileId: first.profileId, name: 'Setup verification' });
  const tab = await tool('browser_session_open', { sessionId: session.id, url: origin });
  let snapshot;
  for (let i = 0; i < 50; i++) {
    try {
      await tool('browser_session_attach', { sessionId: session.id, tabId: tab.tabId });
      snapshot = await tool('browser_observe', { sessionId: session.id, recipe: 'click' });
      if (snapshot.snapshot.targets.length) break;
    } catch (e) { if (i === 49) throw e; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(snapshot.snapshot.targets.length, 1);
  const prepared = await tool('browser_prepare', { sessionId: session.id, recipe: 'click', targetId: snapshot.snapshot.targets[0].id });
  await tool('browser_execute', { sessionId: session.id, actionId: prepared.actionId });
  for (let i = 0; i < 50 && !clicked; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert(clicked, 'The managed extension did not click the actual fixture button');
  await client.close(); await browser('stop', '--profile', 'test');
  assert.deepEqual(JSON.parse((await browser('status', '--profile', 'test')).stdout), { running: false });
  const restarted = JSON.parse((await browser('start', '--profile', 'test', '--headless')).stdout);
  assert.equal(restarted.profileId, first.profileId); assert.deepEqual(restarted.origins, [origin]);
  console.log('PASS: automatic managed installation, idempotent start, MCP -> native -> extension -> real DOM click, shutdown and persistent profile restart.');
} finally {
  await client.close(); await browser('stop', '--profile', 'test');
  fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
  assert.equal(path.dirname(directory), base); await rm(directory, { recursive: true, force: true, maxRetries: 5 });
}
