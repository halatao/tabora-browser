export function cleanupInstallation(root:string,stateDir:string,installationId:string,currentJob:string,inUse?:(directory:string)=>Promise<boolean>):Promise<{deferred:string[]}>;
