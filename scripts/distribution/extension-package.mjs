import path from 'node:path';
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {zip} from './archive.mjs';

export async function packageStoreExtension(source,staging,destination){
  await mkdir(staging);
  const extension=path.join(staging,'extension');
  await cp(source,extension,{recursive:true,errorOnExist:true,force:false});
  const file=path.join(extension,'manifest.json'),manifest=JSON.parse(await readFile(file,'utf8'));
  if(manifest.manifest_version!==3||typeof manifest.key!=='string')throw new Error('invalid_store_manifest_source');
  delete manifest.key;
  await writeFile(file,JSON.stringify(manifest,null,2)+'\n');
  await zip(extension,destination);
}
