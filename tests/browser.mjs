import { chromium } from 'playwright';
import { mkdir, mkdtemp, readFile, writeFile, cp, rm, copyFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
const base=path.resolve('.test-state');await mkdir(base,{recursive:true});const dir=await mkdtemp(path.join(base,'browser-'));
const ext=path.join(dir,'extension');await cp('dist/extension',ext,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(ext,'manifest.json'),'utf8'));
// Pregrant ONLY the synthetic fixture origin in this temporary test build.
manifest.host_permissions=['https://fixture.test/*'];await writeFile(path.join(ext,'manifest.json'),JSON.stringify(manifest));
const id=(await readFile('extension-id.txt','utf8')).trim();
let context;
const watchdog=setTimeout(()=>{console.error('Browser test watchdog timeout.');process.exit(1);},120000);
try {
  context=await chromium.launchPersistentContext(path.join(dir,'profile'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`],env:{...process.env,TABORA_STATE_DIR:path.join(dir,'state'),TABORA_BROWSER_NAME:'Testovací profil'},viewport:{width:1150,height:1050}});
  context.setDefaultTimeout(12000);
  const fixture=await context.newPage();
  await fixture.route('https://fixture.test/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html><head><title>Pilot testovací stránka</title></head><body style="font:16px sans-serif;padding:30px"><h1>Test fixture</h1><form id="profile" aria-label="Kontaktní údaje" onsubmit="event.preventDefault()"><label>Jméno <input name="name"></label><label>Město <input name="city"></label><button type="button" onclick="document.querySelector('#out').textContent='Saved'">Uložit</button></form><form id="login" aria-label="Přihlášení"><label>E-mail <input type="email" name="email"></label><label>Heslo <input type="password" name="password"></label></form><table><caption>Výsledky</caption><tr><th>Jméno</th><th>Body</th></tr><tr><td>Eva</td><td>42</td></tr></table><a href="https://evil.test/">Jiný web</a><p id="out"></p></body></html>`}));
  await fixture.goto('https://fixture.test/');
  const panel=await context.newPage();await panel.goto(`chrome-extension://${id}/panel.html`);
  await panel.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Lokální host připojený',undefined,{timeout:20000});
  const errors=[];panel.on('pageerror',e=>errors.push(e.message));
  console.log('Browser + native host connected.');
  const initial=await panel.evaluate(()=>chrome.runtime.sendMessage({command:'status'}));
  assert.equal(initial.data.profile.mode,'safe');assert.equal(initial.data.profile.mcpEnabled,true);assert.equal(initial.data.profile.vaultEnabled,false);
  assert.equal(await panel.locator('input[id*=model]').count(),0);assert.equal(await panel.locator('#model').evaluate(el=>el.tagName),'SELECT');
  assert.equal(await panel.locator('#settings-toggle').isVisible(),false);
  assert.equal(await panel.locator('#manual-controls').isVisible(),false);
  assert.equal(await panel.locator('#run-start').isVisible(),false);
  assert.equal(await panel.locator('#attachments').isVisible(),false);
  assert.equal(await panel.locator('#vault').isVisible(),false);
  assert.equal(await panel.locator('#active-sessions').isVisible(),false);
  // Verify the shipped permissions in Chrome, without promoting optional
  // permissions in this fixture or mocking a successful permission request.
  assert(manifest.permissions.includes('debugger'));assert(manifest.permissions.includes('downloads'));
  assert(!(manifest.optional_permissions??[]).includes('debugger'));
  assert.equal(await panel.evaluate(()=>chrome.permissions.contains({permissions:['debugger','downloads']})),true);
  await panel.locator('#connection-setup').waitFor({state:'hidden'});
  // Missing permissions must direct the user to Chrome instead of retrying
  // an API that cannot grant debugger. Simulate absence, never consent.
  await panel.evaluate(()=>{
    globalThis.__realContains=chrome.permissions.contains.bind(chrome.permissions);
    chrome.permissions.contains=async()=>false;
    chrome.permissions.request=async()=>{throw new Error('Unexpected runtime permission request');};
  });
  await panel.locator('#refresh').click();await panel.locator('#enable-input').waitFor({state:'visible'});
  const managerPage=context.waitForEvent('page');await panel.locator('#enable-input').click();
  const manager=await managerPage;await manager.waitForURL(`chrome://extensions/?id=${id}`);await manager.close();
  await panel.evaluate(()=>{chrome.permissions.contains=globalThis.__realContains;});
  await panel.locator('#refresh').click();await panel.locator('#connection-setup').waitFor({state:'hidden'});
  await panel.evaluate(()=>chrome.runtime.sendMessage({command:'profile.update',payload:{mcpEnabled:false}}));
  await panel.reload();await panel.locator('#resume-mcp').waitFor({state:'visible'});
  assert.equal((await panel.evaluate(()=>chrome.runtime.sendMessage({command:'status'}))).data.profile.mcpEnabled,false);
  await panel.locator('#resume-mcp').click();await panel.locator('#mcp-paused').waitFor({state:'hidden'});
  await panel.setViewportSize({width:380,height:850});assert(await panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await panel.screenshot({path:'preview-sidepanel.png',fullPage:true});
  await panel.setViewportSize({width:1150,height:1050});await panel.screenshot({path:'preview-panel-desktop.png',fullPage:true});
  // The options page preserves manual workflows without adding them to the main panel.
  assert.equal(manifest.options_page,'panel.html?tools');
  await panel.goto(`chrome-extension://${id}/panel.html?tools`);await panel.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Lokální host připojený');
  await panel.locator('input[name=mode][value=takeover]').check();await panel.waitForFunction(()=>!document.querySelector('#existing-tabs').hidden);
  await panel.locator('#manual-controls').evaluate(el=>el.open=true);
  await panel.locator('#tab').selectOption({label:'Pilot testovací stránka'});
  await panel.locator('#pin').click();await panel.waitForFunction(()=>document.querySelector('#bound')?.textContent?.includes('Připojeno:'));
  await panel.locator('#recipe').selectOption('fill');await panel.locator('#fields').fill('{"Jméno":"Eva","Město":"Praha"}');
  await panel.locator('#observe').click();await panel.waitForFunction(()=>document.querySelector('#snapshot-info')?.textContent?.includes('2 cílů'));
  await panel.locator('#manual-target').selectOption({label:'Kontaktní údaje'});await panel.locator('#manual').click();await panel.locator('#execute').click();
  await panel.waitForFunction(()=>document.querySelector('#outcome-text').textContent.includes('submitted'));
  assert.equal(await fixture.evaluate(()=>document.querySelector('input[name="name"]').value),'Eva');
  assert.equal(await fixture.evaluate(()=>document.querySelector('input[name="city"]').value),'Praha');
  const replay=await panel.evaluate(()=>chrome.runtime.sendMessage({command:'execute'}));assert.equal(replay.ok,false);
  // A rerender between observation and execution must invalidate the target.
  await panel.locator('#observe').click();await panel.locator('#manual').click();
  await fixture.evaluate(()=>{const el=document.getElementById('profile');el.replaceWith(el.cloneNode(true));});
  await panel.locator('#execute').click();await panel.waitForFunction(()=>document.querySelector('#notice').textContent.includes('target_not_ready'));
  // Table extraction is local and bounded.
  await panel.locator('#recipe').selectOption('extract');await panel.locator('#observe').click();await panel.locator('#manual').click();await panel.locator('#execute').click();
  await panel.waitForFunction(()=>document.querySelector('#outcome-text').textContent.includes('42'));
  const csvEvent=panel.waitForEvent('download');await panel.locator('#export-table').click();
  const csv=await csvEvent;assert((await readFile(await csv.path(),'utf8')).includes('"Eva","42"'));
  // Real DPAPI vault -> native host -> bound HTTPS document; no model involved.
  await panel.locator('#vault-enabled').check();await panel.waitForFunction(()=>!document.querySelector('#vault').hidden);
  await panel.locator('#vault-details').evaluate(el=>el.open=true);await panel.locator('#unlock').click();
  await panel.waitForFunction(()=>document.querySelector('#vault-state').textContent.startsWith('Vault je odemčený'));
  await panel.locator('#vault-label').fill('Fixture účet');await panel.locator('#vault-origin').fill('https://fixture.test');await panel.locator('#vault-user').fill('test@example.test');await panel.locator('#vault-password').fill('FAKE-browser-password');await panel.locator('#vault-form button').click();
  await panel.waitForFunction(()=>document.querySelector('#credential').options.length===2);
  await panel.locator('#pin').click();await panel.waitForFunction(()=>document.querySelector('#bound').textContent.includes('Připojeno:'));await panel.locator('#recipe').selectOption('login');await panel.locator('#credential').selectOption({label:'Fixture účet · https://fixture.test'});
  await panel.locator('#observe').click();await panel.waitForFunction(()=>document.querySelector('#snapshot-info').textContent.includes('1 cílů'));
  await panel.locator('#manual').click();await panel.waitForFunction(()=>document.querySelector('#preview-title').textContent==='Přihlášení');
  await panel.locator('#execute').click();
  await panel.waitForFunction(()=>document.querySelector('#outcome-text').textContent.includes('submitted')||document.querySelector('#notice').className!=='success');
  assert.equal(await fixture.evaluate(()=>document.querySelector('input[type="password"]').value),'FAKE-browser-password');
  assert.equal(await panel.locator('#outcome-text').textContent().then(t=>t.includes('FAKE-browser-password')),false);
  // Click must complete even when the pinned document is a background tab.
  await panel.locator('#recipe').selectOption('click');await panel.locator('#observe').click();
  await panel.waitForFunction(()=>Array.from(document.querySelector('#manual-target').options).some(o=>o.textContent==='Uložit'));
  await panel.locator('#manual-target').selectOption({label:'Uložit'});await panel.locator('#manual').click();await panel.locator('#execute').click();
  await panel.waitForFunction(()=>document.querySelector('#outcome-text').textContent.includes('dispatched'));
  assert.equal(await fixture.evaluate(()=>document.querySelector('#out').textContent),'Saved');
  assert((await panel.locator('#outcome-text').textContent()).includes('"verified": false'));
  await panel.locator('#observe').click();
  // Observation replaces the options asynchronously; choose only after that replacement.
  await panel.waitForFunction(()=>!document.querySelector('#observe').disabled);
  await panel.locator('#manual-target').selectOption({label:'Jiný web'});await panel.locator('#manual').click();
  await panel.waitForFunction(()=>document.querySelector('#preview-title').textContent==='Jiný web');
  await panel.locator('#execute').click();
  await panel.waitForFunction(()=>document.querySelector('#notice').textContent.includes('jiný origin'));
  assert.equal(fixture.url(),'https://fixture.test/');
  // Provider failures remain visible and are not credited as fast successful decisions.
  await panel.locator('#recipe').selectOption('login');await panel.locator('#goal').fill('Vyber přihlašovací formulář.');await panel.locator('#observe').click();
  const status=await panel.evaluate(()=>chrome.runtime.sendMessage({command:'status'}));
  assert(!JSON.stringify(status.data.snapshot).includes('FAKE-browser-password'));
  await panel.locator('#settings-toggle').click();await panel.locator('#compare').evaluate(el=>el.open=true);await panel.locator('#benchmark').click();
  await panel.waitForFunction(()=>document.querySelector('#benchmark-state').textContent.includes('není kompletní'));
  assert.equal(await panel.locator('.result').count(),4);
  assert((await panel.locator('#benchmark-cards').textContent()).includes('preview'));
  const downloadEvent=panel.waitForEvent('download');await panel.locator('#export-results').click();
  const download=await downloadEvent,report=JSON.parse(await readFile(await download.path(),'utf8'));
  assert.equal(report.rows.length,4);assert(!JSON.stringify(report).includes('FAKE-browser-password'));assert(!('context' in report));
  await panel.screenshot({path:path.join(dir,'desktop.png'),fullPage:true});await copyFile(path.join(dir,'desktop.png'),'preview.png');
  await panel.setViewportSize({width:380,height:850});assert(await panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await panel.locator('#settings-toggle').click();await panel.screenshot({path:path.join(dir,'sidepanel.png'),fullPage:true});
  await panel.goto(`chrome-extension://${id}/panel.html`);await panel.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Lokální host připojený');
  await panel.locator('#provider').selectOption('codex-sdk');
  await panel.waitForFunction(()=>!document.querySelector('#model').disabled&&document.querySelector('#model').options.length>0,undefined,{timeout:30000});
  assert.equal(await panel.locator('#provider-connection').inputValue(),'sdk');
  assert.equal(await panel.locator('#connect-provider').isVisible(),false);
  const configured=await panel.evaluate(()=>chrome.runtime.sendMessage({command:'status'}));
  assert.equal(configured.data.profile.activeProvider,'codex-sdk');
  assert.equal(configured.data.configs.find(c=>c.provider==='codex-sdk').connection,'sdk');
  assert.equal(configured.data.configs.find(c=>c.provider==='codex-sdk').model,await panel.locator('#model').inputValue());
  await panel.reload();await panel.waitForFunction(()=>!document.querySelector('#model').disabled);
  assert.equal(await panel.locator('#model').inputValue(),configured.data.configs.find(c=>c.provider==='codex-sdk').model);
  assert.equal(await panel.locator('#connect-provider').isVisible(),false);
  // Recover the complete UI after a transient startup failure, without a manual refresh.
  await panel.addInitScript(()=>{
    const send=chrome.runtime.sendMessage.bind(chrome.runtime);let fail=true;
    chrome.runtime.sendMessage=(message,...args)=>{
      if(fail&&message.command==='sessions.list'){fail=false;return Promise.resolve({ok:false,code:'native_host_unavailable'});}
      return send(message,...args);
    };
  });
  await panel.reload();await panel.waitForFunction(()=>document.querySelector('#provider').value==='codex-sdk'&&!document.querySelector('#model').disabled);
  assert.equal(await panel.locator('#model').inputValue(),configured.data.configs.find(c=>c.provider==='codex-sdk').model);
  await panel.locator('#provider').selectOption('agent');
  await panel.waitForFunction(()=>document.querySelector('#provider-connect').hidden);
  await panel.locator('#vault-enabled').uncheck();await panel.waitForFunction(()=>document.querySelector('#vault').hidden);
  await panel.locator('input[name=mode][value=safe]').check();await panel.waitForFunction(()=>document.querySelector('#existing-tabs').hidden);
  await panel.locator('#manual-controls').evaluate(el=>el.open=false);await panel.locator('#vault-details').evaluate(el=>el.open=false);
  await panel.screenshot({path:'preview-sidepanel.png',fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('PASS: minimal panel, actual Chrome debugger/download permissions, missing-permission handoff without runtime requests, preserved MCP revocation, automatic SDK catalog + model persistence, options workflows, native host, pinning, form batch, replay rejection, stale DOM, table + CSV, DPAPI credential fill, background click, cross-origin rejection, four-provider report, responsive layout.');
}catch(error){
  console.error('Browser test failed before cleanup:',error);
  const panel=context?.pages().find(p=>p.url().startsWith('chrome-extension:'));
  if(panel)console.log('Last panel notice:',await panel.locator('#notice').textContent(), 'Outcome:',await panel.locator('#outcome-text').textContent());
  throw error;
}finally {
  await context?.close();assert.equal(path.dirname(dir),base);await rm(dir,{recursive:true,force:true,maxRetries:5});
  clearTimeout(watchdog);
}
