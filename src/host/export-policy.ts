const sensitiveParameter=/(?:^|[_-])(?:access.?token|refresh.?token|token|auth|authorization|password|passwd|secret|api.?key|code|session|signature|credential)(?:$|[_-])/i;
export function publicURL(value:string){
  try{const url=new URL(value);if(!['https:','http:'].includes(url.protocol))return value;let changed=!!url.username||!!url.password;url.username='';url.password='';for(const key of [...url.searchParams.keys()])if(sensitiveParameter.test(key)){url.searchParams.set(key,'[REDACTED]');changed=true;}if(url.hash&&sensitiveParameter.test(url.hash)){url.hash='';changed=true;}return changed?url.href:value;}catch{return value;}
}
/** This is an export boundary, not a mutation of the executor's live navigation URL. */
export function exportData<T>(input:T,redact:(value:any)=>any=value=>value):T{
  const identifier=(key:string,value:string)=>['id','ref','targetId','actionId','sessionId','profileId','runId','artifactId','transferId','rootId','fileRef','captureId','snapshotId','baseSnapshotId','documentId','documentToken','requestId','continuationOf'].includes(key)&&(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)||/^(?:r|t)\d+$/.test(value))||key==='sha256'&&/^[a-f0-9]{64}$/i.test(value)||key==='stateVersion'&&/^[a-f0-9-]{36}:[a-f0-9-]{36}$/i.test(value);
  const walk=(value:unknown,key=''):unknown=>{
    // Locally generated protocol refs are opaque capabilities, not page text. Redacting
    // fragments of a short vault secret in these refs would silently break ownership/binding.
    if(typeof value==='string')return identifier(key,value)?value:redact(value.replace(/https?:\/\/[^\s<>"']+/g,url=>publicURL(url)));
    if(Array.isArray(value))return value.map(item=>walk(item,key==='artifactIds'?'artifactId':key));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,walk(item,key)]));return value;
  };return walk(input) as T;
}
