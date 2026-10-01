export function sdkEnvironment(source=process.env):Record<string,string>{
  const env:Record<string,string>={};
  for(const name of ['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','CODEX_HOME','CLAUDE_CONFIG_DIR'])if(source[name])env[name]=source[name]!;
  return env;
}
