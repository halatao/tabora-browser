import {exactOrigin} from '../shared.js';

// Read browser-created metadata in the isolated world, never page DOM or a
// parent-origin guess. URL origins cannot detect inherited or sandboxed origins.
type FrameAccess={frameId:number;documentId:string;parentFrameId:number;url:string;urlOrigin:string|null;origin:string|null;allowed:boolean;reason?:string;originSource?:'isolated_world';inheritedOrigin?:boolean;browserGranted?:boolean;missingPermission?:string;readerInjected?:boolean};
export async function frameAccess(tabId:number,frame:chrome.webNavigation.GetAllFrameResultDetails,taskOrigins:string[]):Promise<FrameAccess>{
  let urlOrigin:string|null=null;
  try{urlOrigin=exactOrigin(frame.url);}catch{}
  const base={frameId:frame.frameId,documentId:frame.documentId,parentFrameId:frame.parentFrameId,url:frame.url,urlOrigin};
  try{
    const results=await chrome.scripting.executeScript({target:{tabId,documentIds:[frame.documentId]},world:'ISOLATED',func:()=>({url:location.href,origin:globalThis.origin,readerInjected:typeof (globalThis as any).__taboraOperation==='function'})});
    const result=results.find(result=>result.documentId===frame.documentId&&result.frameId===frame.frameId)?.result;
    if(!result||result.url!==frame.url||typeof result.origin!=='string')return {...base,origin:null,allowed:false,reason:'frame_origin_unverified'};
    const origin=result.origin;
    if(origin==='null')return {...base,origin,originSource:'isolated_world',allowed:false,reason:'frame_opaque_origin'};
    let valid=false;try{valid=exactOrigin(origin)===origin;}catch{}
    if(!valid)return {...base,origin,allowed:false,reason:'frame_scheme_not_supported'};
    const permission=origin+'/*',browserGranted=await chrome.permissions.contains({origins:[permission]});
    const inTask=taskOrigins.includes(origin);
    return {...base,origin,originSource:'isolated_world',inheritedOrigin:urlOrigin!==origin,readerInjected:result.readerInjected,browserGranted,allowed:inTask&&browserGranted,reason:!inTask?'frame_origin_not_granted':!browserGranted?'site_permission_required':undefined,missingPermission:browserGranted?undefined:permission};
  }catch{
    // Failed injection is not evidence of the frame's effective origin.
    const missingPermission=urlOrigin&&!await chrome.permissions.contains({origins:[urlOrigin+'/*']})?urlOrigin+'/*':undefined;
    return {...base,origin:null,allowed:false,reason:missingPermission?'site_permission_required':'frame_origin_probe_failed',missingPermission};
  }
}
