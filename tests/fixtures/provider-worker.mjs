let busy=false;
process.on('message',async message=>{
  if(message.kind==='cancel'){process.disconnect();return;}
  if(message.kind!=='start')return;
  if(busy){process.send({id:message.id,ok:false,code:'session_busy'});return;}busy=true;
  if(message.request.question==='Hang')return;
  await new Promise(r=>setTimeout(r,10));
  process.send({id:message.id,ok:true,result:{choiceId:message.request.choices[0].id,model:message.config.model,diagnostics:{transport:'codex-app-server',processId:process.pid,coldStart:false,startupMs:0,threadMs:0,turnMs:10,releaseMs:0}}});busy=false;
});
