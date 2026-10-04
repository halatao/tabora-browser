/** Bound executor concurrency across profiles; never queue model inference here. */
export class InteractiveQueue{
  private tail:Promise<unknown>=Promise.resolve();
  async run<T>(operation:()=>Promise<T>):Promise<T>{
    const previous=this.tail;let release!:()=>void;this.tail=new Promise<void>(resolve=>{release=resolve;});await previous;
    try{return await operation();}finally{release();}
  }
}
export const interactiveCommands=new Set(['v2.commit','v2.capture','step','execute','files.upload']);
