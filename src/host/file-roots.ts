import {z} from 'zod';
import {PilotError} from '../shared.js';

/** Base64 is an installer transport for JSON through Windows PowerShell/cmd argument quoting. */
export function configuredFileRoots(env:NodeJS.ProcessEnv,cwd:string):string[]{
  try{
    let value=env.TABORA_FILE_ROOTS;
    if(env.TABORA_FILE_ROOTS_B64){
      const encoded=env.TABORA_FILE_ROOTS_B64;
      if(encoded.length>100000)throw new Error();
      const bytes=Buffer.from(encoded,'base64');
      if(bytes.toString('base64')!==encoded)throw new Error();
      value=bytes.toString('utf8');
    }
    return z.array(z.string().min(1).max(4000)).max(16).parse(value?JSON.parse(value):[cwd]);
  }catch{throw new PilotError('invalid_file_roots_config');}
}
