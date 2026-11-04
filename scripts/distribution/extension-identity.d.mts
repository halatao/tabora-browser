export type ExtensionChannel='unpacked'|'store';
export type ExtensionIdentities={schema:1;unpacked:string;store?:string};
export function publicKeyId(key:string|Buffer):string;
export function extensionIdentities(root:string):Promise<ExtensionIdentities>;
export function nativeExtensionIds(identities:ExtensionIdentities,channel:ExtensionChannel):string[];
export function nativeExtensionChannel(origin:string,identities:ExtensionIdentities,channel?:ExtensionChannel):ExtensionChannel;
export function compatibleExtension(profile:{contractVersion?:number;extensionChannel?:ExtensionChannel;managedProfile?:string;fingerprint?:string},build:{contractVersion:number;fingerprint:string}):boolean;
export function hasUnpackedExtension(root:string,channel:ExtensionChannel):Promise<boolean>;
