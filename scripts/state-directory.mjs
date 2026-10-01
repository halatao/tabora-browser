import path from 'node:path';
import { readFileSync } from 'node:fs';

export function resolveStateDirectory(env, configurationFile) {
  const override = env.TABORA_STATE_DIR;
  if (override && !path.isAbsolute(override)) throw new Error('TABORA_STATE_DIR must be absolute.');
  let config;
  try {
    config = JSON.parse(readFileSync(configurationFile, 'utf8'));
    if (!config || config.version !== 1 || typeof config.stateDir !== 'string' || !path.isAbsolute(config.stateDir)) throw new Error('Invalid installed state directory. Rerun install-host.ps1.');
    if (config.requestedStateDir !== undefined && (typeof config.requestedStateDir !== 'string' || !path.isAbsolute(config.requestedStateDir))) throw new Error('Invalid installed state directory alias.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (override) {
    const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    // Explicit independent directories remain isolated; map the installed alias.
    if (config && same(override, config.requestedStateDir ?? config.stateDir)) return path.normalize(config.stateDir);
    return path.normalize(override);
  }
  if (config) return path.normalize(config.stateDir);
  if (!env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is missing.');
  return path.resolve(env.LOCALAPPDATA, 'TaboraBrowser');
}
