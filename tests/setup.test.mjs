import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { originPermission, profilePaths, parseBrowserArgs } from '../scripts/setup-lib.mjs';

test('managed site permissions require explicit origins and document port scope', () => {
  assert.deepEqual(originPermission('https://example.com:8443'), { origin: 'https://example.com:8443', pattern: 'https://example.com/*' });
  for (const value of ['https://*.example.com', '<all_urls>', 'file:///C:/test', 'https://user:password@example.com', 'https://example.com/a', 'https://example.com/?token=secret', 'https://example.com/#fragment']) assert.throws(() => originPermission(value));
});
test('profile paths cannot escape the managed directory or use Windows device names', () => {
  const env = { TABORA_STATE_DIR: path.resolve('.test-state') };
  for (const name of ['../other', '..', 'a/b', 'a\\b', 'C:', 'con', 'nul', 'com1', '']) assert.throws(() => profilePaths(name, env));
  const a = profilePaths('work', env), b = profilePaths('personal', env);
  assert.equal(path.dirname(a.directory), path.join(env.TABORA_STATE_DIR, 'managed'));
  assert.notEqual(a.pipe, b.pipe);
  assert.equal(profilePaths('work', env).pipe, a.pipe);
});
test('browser CLI fails on typos and incomplete flags', () => {
  assert.throws(() => parseBrowserArgs(['start', '--allow-origin']));
  assert.throws(() => parseBrowserArgs(['start', '--headles']));
  const args = parseBrowserArgs(['start', '--profile', 'work', '--allow-origin', 'https://example.com', '--headless']);
  assert.equal(args.headless, true); assert.deepEqual(args.origins, ['https://example.com']);
});
