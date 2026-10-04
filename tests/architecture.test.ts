import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../src');
test('autonomous controllers cannot call recipe executors and both transports share admission',async()=>{
  for(const file of ['host/run-controller.ts','host/workflow.ts','host/goal-plan.ts']){
    const source=await readFile(path.join(root,file),'utf8');assert(!/call\(['"](?:observe|manual|step|execute)['"]/.test(source),file);
    assert(!source.includes('pageOperation'),file);
  }
  for(const file of ['host/broker.ts','host/broker-router.ts'])assert((await readFile(path.join(root,file),'utf8')).includes('admitRun('),file);
  for(const file of ['extension/page.ts','host/task-inputs.ts'])await assert.rejects(access(path.join(root,file)));
  const session=await readFile(path.join(root,'extension/session.ts'),'utf8');assert(session.includes('legacyRecipes('));assert(!session.includes('__browserPilot'));
});
