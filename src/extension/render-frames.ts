/** Timers and rAF callbacks are both cleared; a timeout never resumes a write. */
export function renderFrames(timeoutMs=1500,geometryOnly=false):Promise<void>{
  return new Promise((resolve,reject)=>{
    let frame=0,done=false;
    const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);cancelAnimationFrame(frame);error?reject(error):resolve();};
    const timer=setTimeout(()=>finish(geometryOnly?undefined:new Error('background_render_timeout')),geometryOnly?Math.min(100,timeoutMs):timeoutMs);
    frame=requestAnimationFrame(()=>{frame=requestAnimationFrame(()=>finish());});
  });
}
