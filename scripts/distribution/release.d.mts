export const repository:string;
export function compare(a:string,b:string):number;
export function releaseManifest(bytes:Buffer,signature:Buffer,trust:any,options?:{now?:number;sequence?:number;version?:string;contract?:number;arch?:string;channel?:'stable'|'preview'}):any;
export function download(url:string,destination?:string,options?:{maximum?:number;size?:number;sha256?:string;request?:typeof fetch}):Promise<Buffer|string>;
export function hashFile(file:string):Promise<string>;
