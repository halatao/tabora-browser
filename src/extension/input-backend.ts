import type {BrowserAction,ExpectedDialog} from '../capabilities.js';
import {PilotError,exactOrigin} from '../shared.js';
import {withTargetDebugger} from './target-debugger.js';

const keys:Record<string,[string,string,number]>={Enter:['Enter','Enter',13],Tab:['Tab','Tab',9],Escape:['Escape','Escape',27],ArrowUp:['ArrowUp','ArrowUp',38],ArrowDown:['ArrowDown','ArrowDown',40],ArrowLeft:['ArrowLeft','ArrowLeft',37],ArrowRight:['ArrowRight','ArrowRight',39],Home:['Home','Home',36],End:['End','End',35],PageUp:['PageUp','PageUp',33],PageDown:['PageDown','PageDown',34],Backspace:['Backspace','Backspace',8],Delete:['Delete','Delete',46],Space:[' ','Space',32]};
type Point={x:number;y:number};
/** Fixed Chrome Input commands. No caller-supplied CDP methods or expressions. */
export async function nativeInput(tabId:number,action:BrowserAction,point:Point,destination:Point|undefined,validate:(release?:boolean)=>Promise<void>,dialog?:ExpectedDialog,origin?:string){
  return withTargetDebugger(tabId,()=>validate(),async debuggee=>{
  const target=debuggee!;let sent=false,blocked=false,handling:Promise<void>|undefined,dragData:any;
  const opening=(source:chrome.debugger.Debuggee,method:string,params?:any)=>{
    if(source.tabId!==tabId||(source as any).sessionId)return;
    if(method==='Input.dragIntercepted'&&action.type==='drag'){
      const data=params?.data;if(!data||data.files?.length||!Array.isArray(data.items)||data.items.length>5||JSON.stringify(data).length>16000||data.items.some((item:any)=>!['text/plain','text/html','text/uri-list'].includes(item.mimeType)||typeof item.data!=='string')){blocked=true;return;}dragData=data;return;
    }
    if(method!=='Page.javascriptDialogOpening')return;
    let matches=false;try{matches=!!dialog&&params.type===dialog.type&&params.message===dialog.message&&exactOrigin(params.url)===origin;}catch{}
    if(!matches){blocked=true;return;}
    handling=chrome.debugger.sendCommand(target,'Page.handleJavaScriptDialog',{accept:dialog!.accept}).then(()=>{},()=>{blocked=true;});
  };
  try{
    await validate();chrome.debugger.onEvent.addListener(opening);await chrome.debugger.sendCommand(target,'Page.enable');
    const send=async(method:string,params:Record<string,unknown>,release=false)=>{if(handling)await handling;if(blocked)throw new PilotError('needs_user');await validate(release);sent=true;let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([chrome.debugger.sendCommand(target,method,params),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new PilotError(blocked?'needs_user':'native_input_timeout')),3000);})]);}finally{clearTimeout(timer);}};
    if(action.type==='fill')await send('Input.insertText',{text:action.value});
    else if(action.type==='key'){
      const [key,code,windowsVirtualKeyCode]=keys[action.key],modifiers=action.shift?8:0;
      await send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode,modifiers,...(['Enter','Space'].includes(action.key)?{text:action.key==='Enter'?'\r':' '}: {})});
      await send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode,modifiers},true);
    }else if(action.type==='hover')await send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
    else if(action.type==='drag'){
      if(!destination)throw new PilotError('unobserved_target');
      await chrome.debugger.sendCommand(target,'Input.setInterceptDrags',{enabled:true});
      await send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
      await send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});
      for(let i=1;i<=8&&!dragData;i++)await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+(destination.x-point.x)*i/8,y:point.y+(destination.y-point.y)*i/8,button:'left',buttons:1},true);
      if(dragData){await send('Input.dispatchDragEvent',{type:'dragEnter',...destination,data:dragData},true);await send('Input.dispatchDragEvent',{type:'dragOver',...destination,data:dragData},true);await send('Input.dispatchDragEvent',{type:'drop',...destination,data:dragData},true);}
      else await send('Input.dispatchMouseEvent',{type:'mouseReleased',...destination,button:'left',buttons:0,clickCount:1},true);
    }else if(action.type==='click'||action.type==='image_click'||action.type==='check'){
      await send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
      await send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',buttons:0,clickCount:1},true);
    }else throw new PilotError('unsupported_native_action');
    if(handling)await handling;return {dispatch:'sent',outcome:blocked?'unknown':'unverified',backend:'chrome_input',...(blocked?{code:'needs_user'}:{})};
  }catch(error){if(sent)return {dispatch:'unknown',outcome:'unknown',backend:'chrome_input',code:error instanceof PilotError?error.code:'native_input_interrupted'};throw error instanceof PilotError?error:new PilotError('native_input_unavailable');}
  finally{chrome.debugger.onEvent.removeListener(opening);if(action.type==='drag')await chrome.debugger.sendCommand(target,'Input.cancelDragging').catch(()=>{});}
  });
}
