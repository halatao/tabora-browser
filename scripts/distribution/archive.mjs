import {readFile, open, mkdir, writeFile, lstat} from 'node:fs/promises';
import path from 'node:path';
import {deflateRawSync, inflateRawSync} from 'node:zlib';
import {confined, files} from './files.mjs';

const maximumArchive = 1_500_000_000, maximumFile = 512_000_000;
const table = Array.from({length:256}, (_, i) => {let n=i;for(let j=0;j<8;j++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(bytes) {let crc=0xffffffff;for(const byte of bytes)crc=table[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}

export async function zip(root, destination) {
  const entries = await files(root), central = [];
  if (entries.length > 65535) throw new Error('package_entry_limit');
  const output = await open(destination, 'wx');let offset=0;
  try {
    for (const relative of entries) {
      const file=confined(root, relative), info=await lstat(file);
      if(info.size>maximumFile)throw new Error('package_file_limit');
      const name=Buffer.from(relative), bytes=await readFile(file), compressed=deflateRawSync(bytes), crc=crc32(bytes);
      const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(8,8);header.writeUInt32LE(crc,14);header.writeUInt32LE(compressed.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(name.length,26);
      const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x800,8);record.writeUInt16LE(8,10);record.writeUInt32LE(crc,16);record.writeUInt32LE(compressed.length,20);record.writeUInt32LE(bytes.length,24);record.writeUInt16LE(name.length,28);record.writeUInt32LE(offset,42);
      central.push(record,name);await output.writeFile(header);await output.writeFile(name);await output.writeFile(compressed);offset+=header.length+name.length+compressed.length;
      if(offset>maximumArchive)throw new Error('package_size_limit');
    }
    const directory=Buffer.concat(central), end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
    await output.writeFile(directory);await output.writeFile(end);
  } finally {await output.close();}
}

export async function extract(archive, destination) {
  if((await lstat(archive)).size>maximumArchive)throw new Error('package_size_limit');
  const bytes=await readFile(archive);
  let end=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
  if(end<0||bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||bytes.readUInt16LE(end+8)!==bytes.readUInt16LE(end+10))throw new Error('invalid_package_zip');
  const count=bytes.readUInt16LE(end+10), start=bytes.readUInt32LE(end+16), size=bytes.readUInt32LE(end+12);
  if(count===65535||start+size!==end)throw new Error('invalid_package_zip');
  let cursor=start,total=0;const entries=[],seen=new Set();
  for(let i=0;i<count;i++) {
    if(cursor+46>end||bytes.readUInt32LE(cursor)!==0x02014b50)throw new Error('invalid_package_zip');
    const flags=bytes.readUInt16LE(cursor+8), method=bytes.readUInt16LE(cursor+10), compressed=bytes.readUInt32LE(cursor+20), length=bytes.readUInt32LE(cursor+24), nameLength=bytes.readUInt16LE(cursor+28), extra=bytes.readUInt16LE(cursor+30), comment=bytes.readUInt16LE(cursor+32), attributes=bytes.readUInt32LE(cursor+38), local=bytes.readUInt32LE(cursor+42);
    if(cursor+46+nameLength+extra+comment>end||flags!==0x800||![0,8].includes(method)||length>maximumFile||((attributes>>>16)&0xf000)===0xa000||(attributes&0x400))throw new Error('unsupported_package_zip');
    const nameBytes=bytes.subarray(cursor+46,cursor+46+nameLength), relative=new TextDecoder('utf-8',{fatal:true}).decode(nameBytes), file=confined(destination,relative), key=relative.toLowerCase();
    if(seen.has(key))throw new Error('package_name_collision');seen.add(key);total+=length;if(total>maximumArchive)throw new Error('package_expansion_limit');
    if(local+30>start||bytes.readUInt32LE(local)!==0x04034b50||bytes.readUInt16LE(local+6)!==flags||bytes.readUInt16LE(local+8)!==method||bytes.readUInt32LE(local+18)!==compressed||bytes.readUInt32LE(local+22)!==length||bytes.readUInt16LE(local+26)!==nameLength)throw new Error('invalid_package_zip');
    const begin=local+30+nameLength+bytes.readUInt16LE(local+28);
    if(begin+compressed>start||!bytes.subarray(local+30,local+30+nameLength).equals(nameBytes))throw new Error('invalid_package_zip');
    entries.push({file,begin,compressed,length,crc:bytes.readUInt32LE(cursor+16),method});cursor+=46+nameLength+extra+comment;
  }
  if(cursor!==end)throw new Error('invalid_package_zip');
  await mkdir(destination,{recursive:false});
  for(const entry of entries) {
    const input=bytes.subarray(entry.begin,entry.begin+entry.compressed), data=entry.method===0?input:inflateRawSync(input,{maxOutputLength:Math.max(1,entry.length)});
    if(data.length!==entry.length||crc32(data)!==entry.crc)throw new Error('package_crc_mismatch');
    await mkdir(path.dirname(entry.file),{recursive:true});await writeFile(entry.file,data,{flag:'wx'});
  }
}
