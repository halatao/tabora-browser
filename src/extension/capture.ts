import {PilotError} from '../shared.js';
import {withTargetDebugger} from './target-debugger.js';
/** Capture only the caller's bound tab. Screenshot transport remains chunked and local. */
export async function captureRegion(tabId:number,clip:{x:number;y:number;width:number;height:number;scale:number},validate:()=>Promise<void>){
  return withTargetDebugger(tabId,validate,async target=>{
  try{await validate();
    // The clip is already intersected with the visible viewport. Avoid Chrome's
    // viewport-only capture path changing scrollbar layout during that clip.
    const result=await chrome.debugger.sendCommand(target!,'Page.captureScreenshot',{format:'png',clip,captureBeyondViewport:true,fromSurface:true}) as {data:string};
    await validate();if(!result?.data||result.data.length>14000000)throw new PilotError('image_size_limit');return result.data;
  }catch(error){throw error instanceof PilotError?error:new PilotError('capture_unavailable');}
  });
}
