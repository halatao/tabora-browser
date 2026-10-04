/** Inspect image headers before a native decoder allocates pixels. */
export function imageSize(bytes:Uint8Array){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let width=0,height=0;
  if(bytes.length>=24&&[137,80,78,71,13,10,26,10].every((value,index)=>bytes[index]===value)){width=view.getUint32(16);height=view.getUint32(20);}
  else if(bytes[0]===255&&bytes[1]===216){
    let offset=2;while(offset+4<=bytes.length){if(bytes[offset++]!==255)throw Error('invalid_image');const marker=bytes[offset++];if(marker===217||marker===218)break;const length=view.getUint16(offset);if(length<2||offset+length>bytes.length)throw Error('invalid_image');if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){height=view.getUint16(offset+3);width=view.getUint16(offset+5);break;}offset+=length;}
  }
  if(!width||!height)throw Error('invalid_image');if(width>4096||height>4096||width*height>16000000)throw Error('image_size_limit');return {width,height};
}
