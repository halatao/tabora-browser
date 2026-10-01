import path from 'node:path';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';

export const root = path.resolve(import.meta.dirname, '..');
export function profilePaths(name, env = process.env) {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(name)) throw new Error('Use a profile name with 1–48 lowercase letters, digits or hyphens (not a Windows device name).');
  if (!env.TABORA_STATE_DIR && !env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is missing.');
  const state = path.resolve(env.TABORA_STATE_DIR ?? path.join(env.LOCALAPPDATA, 'TaboraBrowser'));
  const directory = path.join(state, 'managed', name);
  const hash = createHash('sha256').update(directory.toLowerCase()).digest('hex').slice(0, 32);
  return { state, directory, profile: path.join(directory, 'chromium'), extension: path.join(directory, 'extension'), pipe: `\\\\.\\pipe\\tabora-managed-${hash}` };
}
export function originPermission(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || value.includes('*')) throw new Error('Expected an explicit HTTP(S) origin without credentials, path, query or wildcard.');
  // Chrome match patterns cover every port on this host; vault checks still use exact origins.
  return { origin: url.origin, pattern: `${url.protocol}//${url.hostname}/*` };
}
export function parseBrowserArgs(args) {
  const options = { command: args.shift() ?? 'start', name: 'default', origins: [], headless: false, enableMcp: false };
  if (!['start', 'stop', 'status', 'run'].includes(options.command)) throw new Error('Usage: browser start|stop|status [--profile name] [--allow-origin https://example.com] [--headless] [--enable-mcp]');
  while (args.length) {
    const key = args.shift();
    if (key === '--headless') options.headless = true;
    else if (key === '--enable-mcp') options.enableMcp = true;
    else if (key === '--profile' || key === '--allow-origin') {
      const value = args.shift(); if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
      if (key === '--profile') options.name = value; else options.origins.push(originPermission(value).origin);
    } else throw new Error(`Unknown argument: ${key}`);
  }
  profilePaths(options.name);
  return options;
}
export function control(pipe, command) {
  return new Promise((resolve, reject) => {
    const socket = connect(pipe); let buffer = '';
    const timer = setTimeout(() => socket.destroy(new Error('Managed browser did not respond.')), 2000);
    socket.on('connect', () => socket.end(command + '\n'));
    socket.on('data', chunk => { buffer += chunk; if (buffer.length > 8192) socket.destroy(new Error('Invalid control response.')); });
    socket.on('error', reject);
    socket.on('close', () => clearTimeout(timer));
    socket.on('end', () => { try { resolve(JSON.parse(buffer)); } catch { reject(new Error('Invalid control response.')); } });
  });
}
