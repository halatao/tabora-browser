import test from 'node:test';
import assert from 'node:assert/strict';
import {enforceSafeTab,enforceRecipe} from '../src/extension/policy.js';
import {chooseBrowserProfile} from '../src/host/browser-profiles.js';
import {sdkEnvironment} from '../src/host/sdk-environment.js';
import {PilotError} from '../src/shared.js';
const code=(value:string)=>(e:unknown)=>e instanceof PilotError&&e.code===value;
test('Safe requires session-created tab, dedicated window and current group',()=>{
 const scope={createdTabs:new Set([7]),safeWindowId:2,groupId:3};
 enforceSafeTab({mode:'safe'},{id:7,windowId:2,groupId:3} as chrome.tabs.Tab,scope);
 for(const tab of [{id:8,windowId:2,groupId:3},{id:7,windowId:9,groupId:3},{id:7,windowId:2,groupId:-1}])assert.throws(()=>enforceSafeTab({mode:'safe'},tab as chrome.tabs.Tab,scope),code('safe_mode_existing_tab'));
 enforceSafeTab({mode:'takeover'},{id:8} as chrome.tabs.Tab,scope);
});
test('Readonly permits extraction only; vault must be enabled for login in other modes',()=>{
 enforceRecipe({mode:'readonly',vaultEnabled:false},'extract');
 for(const recipe of ['click','fill','login'] as const)assert.throws(()=>enforceRecipe({mode:'readonly',vaultEnabled:true},recipe),code('readonly_mode'));
 assert.throws(()=>enforceRecipe({mode:'takeover',vaultEnabled:false},'login'),code('vault_disabled'));
 enforceRecipe({mode:'safe',vaultEnabled:true},'login');
});
test('Profile naming selects only an unambiguous installed profile or explicit selection',()=>{
 const profiles=[{key:'chrome:Default',name:'Private',installed:false},{key:'chrome:Profile 1',name:'Work',installed:true}];
 assert.equal(chooseBrowserProfile(profiles)?.name,'Work');
 profiles[0].installed=true;assert.equal(chooseBrowserProfile(profiles),undefined);
 assert.equal(chooseBrowserProfile(profiles,'chrome:Default')?.name,'Private');
 assert.equal(chooseBrowserProfile([], 'unknown'),undefined);
});
test('Local SDK environment does not inherit unrelated secrets',()=>{
 const env=sdkEnvironment({PATH:'bin',USERPROFILE:'user',CODEX_HOME:'codex',TYPESAFE_API_KEY:'synthetic',ANTHROPIC_API_KEY:'synthetic',TOKEN:'synthetic'});
 assert.deepEqual(env,{PATH:'bin',USERPROFILE:'user',CODEX_HOME:'codex'});
});
