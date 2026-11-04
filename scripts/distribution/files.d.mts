export function confined(root:string,relative:string):string;
export function json(file:string,maximum?:number):Promise<any>;
export function atomicJson(file:string,value:unknown):Promise<void>;
export function plainDirectory(directory:string):Promise<string>;
