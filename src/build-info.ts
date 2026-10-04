declare const __TABORA_BUILD__: {version:string;fingerprint:string;contractVersion:number};
/** Source tests deliberately cannot attest an installed bundle. */
export const buildInfo=typeof __TABORA_BUILD__==='undefined'
  ?{version:'source',fingerprint:'unbundled',contractVersion:2}
  :__TABORA_BUILD__;
