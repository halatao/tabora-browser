type Options={registration?:(root:string)=>unknown;isIdle?:(installed:{root:string;version:string;config:any})=>boolean|Promise<boolean>};
export function switchExtensionChannel(root:string,channel:'unpacked'|'store',options?:Options):Promise<{changed:boolean;channel:string;extensionId:string;allowedExtensionIds:string[];dataRetained?:boolean;profilePermissionsTransferred?:boolean;storeUrl?:string}>;
export function recoverExtensionChannel(root:string,options?:{registration?:(root:string)=>unknown}):Promise<boolean>;
