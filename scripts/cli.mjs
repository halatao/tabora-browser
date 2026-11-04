import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {installation,install,register,removeRegistration,doctor,validateUninstall} from './distribution/installation.mjs';

const payload=path.resolve(import.meta.dirname,'..'),args=process.argv.slice(2);
let command=args.shift()??'help';
if(command.startsWith('chrome-extension://')){args.unshift(command);command='native';}
const options={};
if(!['native','mcp','browser','worker'].includes(command))while(args.length) {
  const name=args.shift();if(['--auto-update','--notify-only','--no-updates'].includes(name)){
    const policy={'--auto-update':'idle-auto','--notify-only':'notify','--no-updates':'off'}[name];
    if(options.policy&&options.policy!==policy)throw new Error('conflicting_update_policy');options.policy=policy;
  }
  else if(name==='--require-profile')options.requireProfile=true;
  else if(['--root','--state-dir','--migrate-from','--channel','--extension-channel'].includes(name)){const value=args.shift();if(!value||value.startsWith('--'))throw new Error('missing_cli_argument');options[{'--root':'root','--state-dir':'stateDir','--migrate-from':'migrateFrom','--channel':'channel','--extension-channel':'extensionChannel'}[name]]=value;}
  else if(command==='update'&&!options.operation)options.operation=name;
  else if(command==='update'&&!options.updateId)options.updateId=name;
  else if(command==='update'&&!options.ticket)options.ticket=name;
  else throw new Error('unknown_cli_argument');
}
try {
  if(command==='native'||command==='mcp'||command==='worker') {
    const entry=command==='native'?'main':command==='worker'?'update-worker':'mcp';process.argv=[process.argv[0],path.join(payload,'dist/host',entry+'.js'),...args];
    await import(pathToFileURL(path.join(payload,'dist/host',entry+'.js')).href);
  } else if(command==='browser') {
    if(args.length===1&&args[0]==='install')execFileSync(process.execPath,[path.join(payload,'node_modules/playwright/cli.js'),'install','chromium'],{stdio:'inherit',windowsHide:true});
    else{process.argv=[process.argv[0],path.join(payload,'scripts/browser.mjs'),...args];await import('./browser.mjs');}
  }
  else if(command==='install') {
    const result=await install(payload,options.root??path.join(process.env.LOCALAPPDATA,'Programs/TaboraBrowser'),options);
    console.log(JSON.stringify({installed:!result.status,status:result.status,updateId:result.updateId,root:result.root,extensionId:result.config.extensionId,extensionChannel:result.config.installKind,extensionDirectory:result.config.installKind==='unpacked'?path.join(result.root,'extension-unpacked'):undefined,nextStep:result.status?'Use update status to verify completion; reconnect MCP when requested.':result.config.installKind==='store'?'Install the matching published Store extension, complete browser consent and reconnect MCP.':'Load unpacked once in the intended Chrome profile; reconnect your MCP client.'}));
  } else if(['doctor','repair','uninstall','uninstall-check','update','mcp-config'].includes(command)) {
    const root=options.root??process.env.TABORA_INSTALL_ROOT;if(!root)throw new Error('installed_root_required');
    const installed=await installation(root);process.env.TABORA_INSTALL_ROOT=installed.root;process.env.TABORA_STATE_DIR=installed.config.stateDir;
    if(command==='doctor')console.log(JSON.stringify(await doctor(root,options.requireProfile)));
    if(command==='mcp-config')console.log(JSON.stringify({mcpServers:{'tabora-browser':{command:path.join(installed.root,'tabora.exe'),args:['mcp']}}},null,2));
    if(command==='repair'){
      const {updateCli}=await import(pathToFileURL(path.join(payload,'dist/host/update-worker.js')).href);
      const recovery=await updateCli('recover');if(recovery.status==='waiting_for_idle')console.log(JSON.stringify(recovery));else register(root);
    }
    if(command==='uninstall')console.log(JSON.stringify(await removeRegistration(root)));
    if(command==='uninstall-check')console.log(JSON.stringify(await validateUninstall(root)));
    if(command==='update') {
      const {updateCli}=await import(pathToFileURL(path.join(payload,'dist/host/update-worker.js')).href);console.log(JSON.stringify(await updateCli(options.operation??'check',options.updateId,options.ticket)));
    }
  } else if(command==='version') {console.log(await (await import('node:fs/promises')).readFile(path.join(payload,'dist/build-info.json'),'utf8'))}
  else if(command==='help')console.log('Tabora: install [--root PATH] [--state-dir PATH] [--auto-update|--notify-only|--no-updates] [--channel stable|preview] [--extension-channel unpacked|store] [--migrate-from CHECKOUT] | mcp | mcp-config | doctor [--require-profile] | repair | uninstall | browser install|start|stop|status ... | update check|prepare|apply|status|recover [UPDATE_ID] [TICKET]');
  else throw new Error('unknown_cli_command');
} catch(error) {console.error(/^\w+(?::[^\r\n]*)?$/.test(error.message)?error.message:'tabora_command_failed');process.exitCode=1;}
