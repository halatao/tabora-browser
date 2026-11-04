import path from 'node:path';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {execFile,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {install,validatePayload} from '../scripts/distribution/installation.mjs';
import {extract} from '../scripts/distribution/archive.mjs';
const exec=promisify(execFile),sourcePayload=path.resolve(process.argv[2]??'release/payload'),base=path.resolve('.test-state');
await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'package-smoke-'));
const root=path.join(directory,'Instalace Žluťoučká'),state=path.join(directory,'state');
try {
  const packageVersion=JSON.parse(await readFile(path.join(sourcePayload,'package.json'),'utf8')).version;
  const payload=path.join(directory,'extracted');await extract(path.join(path.dirname(sourcePayload),`tabora-${packageVersion}-windows-x64.zip`),payload);
  const installed=await install(payload,root,{stateDir:state,registration(){}});
  const environment={...process.env,PATH:[process.env.SystemRoot,path.join(process.env.SystemRoot,'System32'),path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0')].join(';'),TABORA_UPDATE_CHECK:'0'};
  assert(!environment.PATH.toLowerCase().includes('node'));
  const version=await exec(path.join(root,'tabora.exe'),['version'],{env:environment,windowsHide:true,timeout:30000});assert.equal(JSON.parse(version.stdout).version,JSON.parse(await readFile(path.join(payload,'package.json'),'utf8')).version);
  await exec(path.join(installed.version,'runtime/node.exe'),['--input-type=module','-e',"const canvas=await import('@napi-rs/canvas');if(!canvas.createCanvas(2,2).toBuffer('image/png').length)throw Error('canvas');await import('@openai/codex-sdk');await import('@anthropic-ai/claude-agent-sdk');await import('playwright');await import('tesseract.js');await import('pdfjs-dist/legacy/build/pdf.mjs');"],{cwd:installed.version,env:environment,windowsHide:true,timeout:30000});
  const native=spawn(path.join(root,'tabora.exe'),['chrome-extension://'+installed.config.extensionId+'/'],{env:environment,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const replies=new Map();let input=Buffer.alloc(0);native.stderr.resume();
  native.stdout.on('data',chunk=>{input=Buffer.concat([input,chunk]);while(input.length>=4&&input.length>=4+input.readUInt32LE(0)){const size=input.readUInt32LE(0),message=JSON.parse(input.subarray(4,4+size));input=input.subarray(4+size);const reply=replies.get(message.id);if(reply){replies.delete(message.id);clearTimeout(reply.timer);reply.resolve(message);}}});
  const nativeCall=(command,payload)=>new Promise((resolve,reject)=>{const id=randomUUID(),bytes=Buffer.from(JSON.stringify({id,version:1,command,payload})),header=Buffer.alloc(4);header.writeUInt32LE(bytes.length);const timer=setTimeout(()=>reject(new Error('Packaged native messaging timeout')),20000);replies.set(id,{resolve,timer});native.stdin.write(Buffer.concat([header,bytes]));});
  try{assert((await nativeCall('hello',{id:randomUUID(),name:'Package native fixture',mcpEnabled:false})).ok);assert((await nativeCall('status')).data.locked);}finally{native.stdin.end();}
  const doctor=await exec(path.join(root,'tabora.exe'),['doctor'],{env:environment,windowsHide:true,timeout:120000});const health=JSON.parse(doctor.stdout);assert(health.mcp);assert.equal(health.profileConnected,false);
  const result=await exec(path.join(root,'tabora.exe'),['update','check'],{env:environment,windowsHide:true,timeout:30000});const update=JSON.parse(result.stdout);assert.equal(update.status,'disabled');assert.equal(update.installKind,'unpacked');
  const file=path.join(installed.version,'release-trust.json');await writeFile(file,'{}');await assert.rejects(validatePayload(installed.version),/inventory/);
  await new Promise(resolve=>setTimeout(resolve,3500));
  await install(payload,root,{stateDir:state,registration(){}});await validatePayload(installed.version);
  console.log('PASS: exact standalone payload, bundled launcher/runtime, binary native messaging, Unicode path, isolated state, real interactive MCP broker and doctor without Node/Git on PATH; tampered inventory rejected. No native registry or user MCP configuration changed.');
} finally {
  await new Promise(resolve=>setTimeout(resolve,3500));
  assert(directory.startsWith(base+path.sep));
  if(process.env.TABORA_KEEP_PACKAGE_TEST_STATE==='1')console.log('Retained isolated package fixture: '+directory);
  else await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:300});
}
