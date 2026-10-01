import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PilotError } from '../shared.js';

export function withoutTools(body: unknown): Record<string,unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PilotError('invalid_request');
  return {...body, tools:[], tool_choice:'none', parallel_tool_calls:false, store:false};
}
export function guardResponseEvent(event: any) {
  const check = (item: any) => {
    if (item && !['message','reasoning'].includes(item.type)) throw new PilotError('tool_call_blocked');
  };
  if (event?.type?.includes('function_call') || event?.type?.includes('custom_tool')) throw new PilotError('tool_call_blocked');
  if (event?.item) check(event.item);
  for (const item of event?.response?.output ?? []) check(item);
}
/** The SDK gets a random one-run bearer, never the real provider credential. */
export async function createCodexProxy(apiKey: string, signal: AbortSignal, upstreamFetch: typeof fetch = fetch) {
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (req,res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from('Bearer '+token);
    if (req.headers.origin || req.method!=='POST' || req.url!=='/v1/responses' || supplied.length!==expected.length || !timingSafeEqual(supplied,expected)) {
      res.writeHead(403).end(); return;
    }
    try {
      let bytes=0; const chunks:Buffer[]=[];
      for await (const chunk of req) { bytes+=chunk.length; if(bytes>512*1024) throw new Error('size'); chunks.push(chunk); }
      const body = withoutTools(JSON.parse(Buffer.concat(chunks).toString()));
      const response = await upstreamFetch('https://api.openai.com/v1/responses', {
        method:'POST', headers:{authorization:'Bearer '+apiKey,'content-type':'application/json'},
        body:JSON.stringify(body), signal, redirect:'error',
      });
      if (!response.ok || !response.body) { res.writeHead(response.status).end(JSON.stringify({error:{message:'Provider request failed'}})); return; }
      if (!response.headers.get('content-type')?.includes('text/event-stream')) {
        const result:any = await response.json(); for(const item of result.output ?? []) guardResponseEvent({item});
        res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(result)); return;
      }
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});
      let pending=''; const decoder=new TextDecoder();
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk,{stream:true}).replace(/\r\n/g,'\n');
        if(pending.length>1024*1024) throw new Error('size');
        let boundary:number;
        while((boundary=pending.indexOf('\n\n'))>=0) {
          const block=pending.slice(0,boundary); pending=pending.slice(boundary+2);
          const data=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');
          if(data && data!=='[DONE]') guardResponseEvent(JSON.parse(data));
          res.write(block+'\n\n');
        }
      }
      if(pending.trim()) throw new Error('incomplete_stream');
      res.end();
    } catch {
      if(!res.headersSent) res.writeHead(502).end('{"error":{"message":"Decision transport rejected"}}');
      else res.destroy();
    }
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address(); if(!address || typeof address==='string') throw new Error('address');
  return {token, url:`http://127.0.0.1:${address.port}/v1`, close:()=>{server.closeAllConnections();server.close();}};
}
