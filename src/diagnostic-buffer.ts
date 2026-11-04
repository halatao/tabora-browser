import {actionDiagnosticSchema,type ActionDiagnostic} from './shared.js';
export class DiagnosticBuffer{
  private events:{at:number;code:string;details:ActionDiagnostic}[]=[];
  constructor(private now=Date.now){}
  add(code:string,details:ActionDiagnostic){
    const parsed=actionDiagnosticSchema.safeParse(details);if(!parsed.success)return;
    this.prune();this.events.push({at:this.now(),code:/^[a-z_]{1,80}$/.test(code)?code:'internal_error',details:parsed.data});
    if(this.events.length>100)this.events.shift();
  }
  private prune(){this.events=this.events.filter(event=>this.now()-event.at<15*60*1000);}
  snapshot(){
    this.prune();const events:typeof this.events=[];let bytes=2;
    for(const event of [...this.events].reverse()){
      const size=new TextEncoder().encode(JSON.stringify(event)).byteLength+1;
      if(bytes+size>128000)break;bytes+=size;events.unshift({...event,details:structuredClone(event.details)});
    }
    return {events,truncated:events.length<this.events.length};
  }
  read(){return this.snapshot().events;}
}
