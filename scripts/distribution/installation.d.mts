export function installation(root:string,options?:{allowMissingVersion?:boolean}):Promise<{root:string;config:any;version:string}>;
export function validatePayload(payload:string):Promise<{info:any;id:string;extensionId:string;channel:'stable'|'preview'}>;
