import {PilotError,exactOrigin} from '../shared.js';
/** Observe only the ID returned by this explicit request, never browser download history. */
export async function downloadLink(url:string,sessionId:string,name:string,validate:()=>Promise<void>,allowedOrigins:string[],timeoutMs:number){
  if(!await chrome.permissions.contains({permissions:['downloads']}))throw new PilotError('downloads_permission_required');
  await validate();const id=await chrome.downloads.download({url,filename:`Tabora/${sessionId}/${crypto.randomUUID()}/${name}`,saveAs:false,conflictAction:'uniquify'});
  let complete=false;
  try{
    const item=await new Promise<chrome.downloads.DownloadItem>((resolve,reject)=>{
      let checking=false,finished=false;
      const finish=(error?:Error,item?:chrome.downloads.DownloadItem)=>{if(finished)return;finished=true;clearTimeout(deadline);clearInterval(poll);chrome.downloads.onChanged.removeListener(changed);if(error)reject(error);else resolve(item!);};
      const check=async()=>{if(checking||finished)return;checking=true;try{
        await validate();const [item]=await chrome.downloads.search({id});if(!item)throw new PilotError('download_missing');
        if(item.totalBytes>50000000||item.bytesReceived>50000000)throw new PilotError('file_size_limit');
        if(!allowedOrigins.includes(exactOrigin(item.finalUrl||item.url)))throw new PilotError('navigation_out_of_scope');
        if(item.state==='interrupted')throw new PilotError('download_interrupted');if(item.state==='complete')finish(undefined,item);
      }catch(error){finish(error instanceof PilotError?error:new PilotError('download_failed'));}finally{checking=false;}};
      const changed=(delta:chrome.downloads.DownloadDelta)=>{if(delta.id===id)void check();};
      const deadline=setTimeout(()=>finish(new PilotError('download_timeout')),timeoutMs),poll=setInterval(()=>void check(),200);
      chrome.downloads.onChanged.addListener(changed);void check();
    });complete=true;await validate();return {downloadId:id,filename:item.filename,size:item.fileSize,origin:exactOrigin(item.finalUrl||item.url),state:'complete'};
  }finally{if(!complete)await chrome.downloads.cancel(id).catch(()=>{});}
}
