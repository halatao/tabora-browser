import {PilotError} from '../shared.js';
import type {Peer} from './ipc.js';
type Link=Pick<Peer,'call'|'close'|'onclose'>;

/** Reconnect for the next request only. Never replay a possibly executed action. */
export class McpConnection {
  private peer?:Link;
  private connecting?:Promise<Link>;
  private closed=false;
  constructor(private open:()=>Promise<Link>){}
  async ready():Promise<Link>{
    if(this.closed)throw new PilotError('connection_lost');
    if(this.peer)return this.peer;
    if(this.connecting)return this.connecting;
    const pending=this.open().then(peer=>{
      if(this.closed){peer.close();throw new PilotError('connection_lost');}
      this.peer=peer;
      peer.onclose=()=>{if(this.peer===peer)this.peer=undefined;};
      return peer;
    });
    this.connecting=pending;
    try{return await pending;}finally{if(this.connecting===pending)this.connecting=undefined;}
  }
  async call(command:string,payload:unknown){
    const peer=await this.ready();
    try{return await peer.call(command,payload);}
    catch(error){
      if(error instanceof PilotError&&['connection_lost','ipc_timeout'].includes(error.code)){
        if(this.peer===peer)this.peer=undefined;peer.close();
      }
      throw error;
    }
  }
  close(){this.closed=true;this.peer?.close();this.peer=undefined;}
}
