import { chromium } from 'playwright';
import { cp, mkdir, open, readFile, writeFile, unlink } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import path from 'node:path';
import { root, profilePaths, originPermission, parseBrowserArgs, control } from './setup-lib.mjs';

if (process.platform !== 'win32') throw new Error('Tabora currently supports Windows only.');
const options = parseBrowserArgs(process.argv.slice(2));
const paths = profilePaths(options.name);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function status() {
  try { return await control(paths.pipe, 'status'); }
  catch (error) { if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return undefined; throw error; }
}
async function launch() {
  if (options.command === 'status') { console.log(JSON.stringify(await status() ?? { running: false })); return; }
  if (options.command === 'stop') {
    if (!await status()) { console.log('Already stopped.'); return; }
    await control(paths.pipe, 'stop');
    for (let i = 0; i < 200; i++) { if (!await status()) { console.log('Managed browser stopped.'); return; } await sleep(100); }
    throw new Error('Browser shutdown is taking longer than expected. Check browser status.');
  }
  const existing = await status();
  if (existing) {
    if (options.origins.some(origin => !existing.origins?.includes(origin)) || options.enableMcp) throw new Error('Stop this managed profile before changing its permissions or MCP setting.');
    if (!existing.ready) throw new Error('This managed profile is still starting.');
    console.log(JSON.stringify(existing)); return;
  }
  await mkdir(paths.directory, { recursive: true });
  if (options.command === 'run') { await worker(); return; }
  const log = openSync(path.join(paths.directory, 'browser.log'), 'a');
  const child = spawn(process.execPath, [path.join(root, 'scripts/browser.mjs'), 'run', ...process.argv.slice(3)], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
  closeSync(log); child.unref();
  let failure; child.on('error', error => { failure = error; }); child.on('exit', code => { failure = new Error(`Browser exited (${code}). See ${path.join(paths.directory, 'browser.log')}`); });
  for (let i = 0; i < 450; i++) {
    if (failure) throw failure;
    const current = await status();
    if (current?.ready) { console.log(JSON.stringify(current)); return; }
    await sleep(100);
  }
  throw new Error('Browser startup timed out. Check browser status and its local log before retrying.');
}

async function worker() {
  const lockPath = path.join(paths.directory, 'process.json');
  // An exclusive lock protects profile files during simultaneous agent starts.
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = JSON.parse(await readFile(lockPath, 'utf8'));
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error('Invalid managed lock. Inspect it before removal.');
    try { process.kill(previous.pid, 0); throw new Error('Managed profile is in use.'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
    throw new Error(`Stale managed profile lock: ${lockPath}. Inspect that profile and remove the lock only after confirming no browser is using it.`);
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.close();
  let context, server, closing = false;
  const info = { running: true, ready: false, name: options.name, origins: [], headless: options.headless };
  const close = async () => {
    if (closing) return; closing = true; info.ready = false;
    try {
      if (context) {
        let timer;
        const closed = await Promise.race([context.close().then(() => true, () => false), new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
        clearTimeout(timer);
        if (!closed) await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/close-managed.ps1'), '-ProfilePath', paths.profile], { windowsHide: true, timeout: 10000 });
      }
    } finally {
      await unlink(lockPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
      server?.close();
    }
  };
  try {
    server = createServer(socket => {
      socket.setTimeout(2000, () => socket.destroy()); let data = '';
      socket.on('error', () => {});
      socket.on('data', chunk => {
        data += chunk; if (data.length > 32) { socket.destroy(); return; }
        if (!data.includes('\n')) return;
        const command = data.trim();
        socket.end(JSON.stringify(command === 'status' ? info : { stopping: command === 'stop' }));
        if (command === 'stop') void close().then(() => process.exit(0), () => process.exit(1));
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(paths.pipe, resolve); });
    const configPath = path.join(paths.directory, 'config.json'); let previous;
    try { previous = JSON.parse(await readFile(configPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const origins = [...new Set([...(previous?.origins ?? []), ...options.origins])].map(x => originPermission(x).origin);
    info.origins = origins;
    await cp(path.join(root, 'dist/extension'), paths.extension, { recursive: true });
    const manifestPath = path.join(paths.extension, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if(origins.length)manifest.host_permissions = [...new Set(origins.map(x => originPermission(x).pattern))];
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    context = await chromium.launchPersistentContext(paths.profile, { channel: 'chromium', headless: options.headless, args: [`--disable-extensions-except=${paths.extension}`, `--load-extension=${paths.extension}`], env: { ...process.env, TABORA_STATE_DIR: paths.state, TABORA_BROWSER_NAME: options.name } });
    const id = (await readFile(path.join(root, 'extension-id.txt'), 'utf8')).trim();
    const panel = await context.newPage(); await panel.goto(`chrome-extension://${id}/panel.html`);
    await panel.waitForFunction(() => document.querySelector('#connection')?.textContent === 'Lokální host připojený', undefined, { timeout: 30000 });
    const result = await panel.evaluate(async ({ first, name, enable }) => {
      if (first || enable) return chrome.runtime.sendMessage({ command: 'profile.update', payload: { name, nameSource:'selected', mcpEnabled: true } });
      const status = await chrome.runtime.sendMessage({ command: 'status' });
      return { ok: status.ok, data: status.data?.profile };
    }, { first: !previous, name: options.name, enable: options.enableMcp });
    if (!result.ok) throw new Error('Unable to initialize managed profile.');
    await writeFile(configPath, JSON.stringify({ origins }, null, 2));
    info.profileId = result.data.id; info.mcpEnabled = result.data.mcpEnabled; info.ready = true;
    context.on('close', () => { if (!closing) void close().then(() => process.exit(0), () => process.exit(1)); });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void close().then(() => process.exit(0), () => process.exit(1)); });
  } catch (error) { await close(); throw error; }
}
await launch().catch(error => { console.error(error.message); process.exitCode = 1; });
