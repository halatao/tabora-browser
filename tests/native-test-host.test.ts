import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
// @ts-expect-error Test-only JavaScript helper.
import {validateTestNativeHost} from './native-test-host.mjs';

test('source browser tests accept only their own state-overridable native launcher',()=>{
  const root=path.resolve('.test-state/source-fixture'),registration=path.join(root,'dist/native-host/com.tabora.browser.json'),manifest={name:'com.tabora.browser',path:path.join(root,'dist/native-host/host.cmd')};
  assert.doesNotThrow(()=>validateTestNativeHost(registration,manifest,root,undefined));
  for(const [registered,definition,installed] of [
    [path.resolve('.test-state/installed/native-host.json'),manifest,undefined],
    [registration,{...manifest,path:path.resolve('.test-state/installed/tabora.exe')},undefined],
    [registration,manifest,path.resolve('.test-state/installed')],
  ])assert.throws(()=>validateTestNativeHost(registered,definition,root,installed),/native_test_registration_required/);
});
