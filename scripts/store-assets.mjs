import {requireSourceTestNativeHost} from '../tests/native-test-host.mjs';
import {chromium} from 'playwright';
import {mkdir,mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createCanvas,loadImage} from '@napi-rs/canvas';

// This exporter must never connect its synthetic profile to a user's installed host.
requireSourceTestNativeHost();
const base=path.resolve('.test-state');await mkdir(base,{recursive:true});
const fixture=await mkdtemp(path.join(base,'store-assets-')),extension=path.join(fixture,'extension');
const output=path.resolve('reports/store-assets');await mkdir(output,{recursive:true});
let context;
try{
  await cp('dist/extension',extension,{recursive:true});
  const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
  manifest.host_permissions=['https://fixture.test/*'];await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
  context=await chromium.launchPersistentContext(path.join(fixture,'browser'),{channel:'chromium',headless:true,viewport:{width:1280,height:800},deviceScaleFactor:1,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],env:{...process.env,TABORA_STATE_DIR:path.join(fixture,'state'),TABORA_BROWSER_NAME:'Ukázkový profil'}});
  const id=(await readFile('extension-id.txt','utf8')).trim(),panel=await context.newPage();
  await panel.goto(`chrome-extension://${id}/panel.html`);
  await panel.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Lokální host připojený',undefined,{timeout:30000});
  for(const mode of ['safe','readonly']){
    await panel.locator(`input[name=mode][value=${mode}]`).check();
    await panel.waitForFunction(async expected=>(await chrome.runtime.sendMessage({command:'status'})).data?.profile.mode===expected,mode);
    const status=await panel.evaluate(()=>chrome.runtime.sendMessage({command:'status'}));
    assert.equal(status.data.profile.mode,mode);assert.equal(status.data.profile.vaultEnabled,false);assert.equal(status.data.profile.activeProvider,'agent');
    await panel.screenshot({path:path.join(output,`tabora-${mode}-1280x800.png`),omitBackground:false});
  }
  const icon=createCanvas(128,128),image=await loadImage('src/extension/icon.png');
  icon.getContext('2d').drawImage(image,0,0,128,128);await writeFile(path.join(output,'icon-128.png'),icon.toBuffer('image/png'));
  await writeFile(path.join(output,'provenance.json'),JSON.stringify({schema:1,build:JSON.parse(await readFile('dist/build-info.json','utf8')),fixture:'isolated synthetic browser profile; real bundled panel and native host; external-agent provider; no customer data or credentials',screenshots:['tabora-safe-1280x800.png','tabora-readonly-1280x800.png'],icon:'existing extension artwork resized to 128x128'},null,2)+'\n');
  console.log('Store assets exported from the real panel in an isolated synthetic profile.');
}finally{
  await context?.close();await new Promise(resolve=>setTimeout(resolve,3500));
  assert(fixture.startsWith(base+path.sep));await rm(fixture,{recursive:true,force:true,maxRetries:5,retryDelay:300});
}
