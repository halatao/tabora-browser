import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile, rename, mkdir, lstat, realpath, readdir} from 'node:fs/promises';

export function confined(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':') || relative.startsWith('/')) throw new Error('invalid_package_path');
  const segments = relative.split('/');
  if (segments.some(part => !part || part === '.' || part === '..' || /[<>"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new Error('invalid_package_path');
  const result = path.resolve(root, ...segments);
  if (!result.startsWith(path.resolve(root) + path.sep)) throw new Error('invalid_package_path');
  return result;
}
export async function json(file, maximum = 131072) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error('invalid_local_metadata');
  return JSON.parse(await readFile(file, 'utf8'));
}
export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), {recursive: true});
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  for(let attempt=0;;attempt++){
    try{await rename(temporary,file);break;}
    catch(error){if(attempt>=5||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;await new Promise(resolve=>setTimeout(resolve,50*(attempt+1)));}
  }
}
export async function plainDirectory(directory) {
  const absolute = path.resolve(directory);
  const actual = await realpath(absolute);
  if (actual.toLowerCase() !== absolute.toLowerCase()) throw new Error('installation_reparse_path');
  let current = absolute;
  while (path.dirname(current) !== current) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error('installation_reparse_path');
    current = path.dirname(current);
  }
  return absolute;
}
export async function files(root, prefix = '') {
  const result = [];
  for (const entry of (await readdir(root, {withFileTypes: true})).sort((a,b) => a.name.localeCompare(b.name))) {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error('package_symlink');
    if (entry.isDirectory()) result.push(...await files(path.join(root, entry.name), relative + '/'));
    else if (entry.isFile()) result.push(relative);
    else throw new Error('package_special_file');
  }
  return result;
}
export async function mapBounded(items,operation,concurrency=8) {
  const results=new Array(items.length);let cursor=0;
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{
    for(;;){const index=cursor++;if(index>=items.length)return;results[index]=await operation(items[index],index);}
  }));return results;
}
