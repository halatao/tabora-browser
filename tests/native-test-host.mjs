import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

export function validateTestNativeHost(registration,manifest,root,installedRoot){
  const same=(left,right)=>typeof left==='string'&&path.resolve(left).toLowerCase()===path.resolve(right).toLowerCase();
  if(installedRoot||!same(registration,path.join(root,'dist/native-host/com.tabora.browser.json'))||manifest?.name!=='com.tabora.browser'||!same(manifest.path,path.join(root,'dist/native-host/host.cmd'))){
    throw new Error('native_test_registration_required: refusing to run source browser tests against a packaged or foreign host. Use CI or a separate Windows test account with this checkout registered; user data must remain isolated.');
  }
}

export function requireSourceTestNativeHost(root=path.resolve(import.meta.dirname,'..')){
  for(const browser of ['Google\\Chrome','Microsoft\\Edge','Chromium']){
    const output=execFileSync('reg.exe',['query',`HKCU\\Software\\${browser}\\NativeMessagingHosts\\com.tabora.browser`,'/ve'],{encoding:'utf8',windowsHide:true});
    const registration=output.match(/REG_SZ\s+([^\r\n]+)/)?.[1]?.trim();
    // Check the registered path before reading any manifest outside the checkout.
    validateTestNativeHost(registration,{name:'com.tabora.browser',path:path.join(root,'dist/native-host/host.cmd')},root,process.env.TABORA_INSTALL_ROOT);
    validateTestNativeHost(registration,JSON.parse(readFileSync(registration,'utf8')),root,process.env.TABORA_INSTALL_ROOT);
  }
}
