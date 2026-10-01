import test from 'node:test';
import assert from 'node:assert/strict';
import {providerCatalog} from '../src/host/provider-catalog.js';
test('Jev catalog uses the authenticated official endpoint and validates its model list',async()=>{
 const config={provider:'typesafe-jev' as const,connection:'environment' as const,model:'',timeoutMs:30000};
 const fetcher:typeof fetch=async(url,init)=>{assert.equal(url,'https://api.typesafe.ai/v1/models');assert.equal((init?.headers as any).authorization,'Bearer synthetic');assert.equal(init?.redirect,'error');return Response.json({models:[{name:'jev-test'}]});};
 assert.deepEqual((await providerCatalog(config,'.test-state','synthetic',fetcher)).models,[{id:'jev-test',label:'jev-test'}]);
 assert.equal((await providerCatalog(config,'.test-state')).state,'missing_api_key');
 await assert.rejects(providerCatalog(config,'.test-state','synthetic',async()=>new Response('',{status:401})),{message:'authentication_failed'});
 await assert.rejects(providerCatalog(config,'.test-state','synthetic',async()=>Response.json({models:[{name:123}]})));
});
test('Codex API catalog excludes non-text models and Decisions never substitutes another provider',async()=>{
 const config={provider:'codex-sdk' as const,connection:'vault' as const,model:'',timeoutMs:30000};
 const result=await providerCatalog(config,'.test-state','synthetic',async url=>{assert.equal(url,'https://api.openai.com/v1/models');return Response.json({data:['gpt-test','gpt-test','o3','gpt-audio','text-embedding','gpt-image-1'].map(id=>({id}))});});
 assert.deepEqual(result.models.map(m=>m.id),['gpt-test','o3']);
 assert.deepEqual(await providerCatalog({...config,provider:'openai-decisions'},'.test-state'),{state:'preview_unavailable',models:[]});
});
