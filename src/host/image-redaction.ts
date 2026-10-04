import {imageSize} from '../image-size.js';
import {PilotError} from '../shared.js';
export type ImageMask={x:number;y:number;width:number;height:number};
/** Privacy masks are burned into pixels locally, independently of mutable page overlays. */
export async function redactImage(bytes:Uint8Array,geometry:{width:number;height:number;masks:ImageMask[]}){
  const size=imageSize(bytes);
  if(!Number.isFinite(geometry.width)||!Number.isFinite(geometry.height)||geometry.width<=0||geometry.height<=0||geometry.masks.length>5000)throw new PilotError('capture_redaction_failed');
  const {loadImage,createCanvas}=await import('@napi-rs/canvas');
  const image=await loadImage(Buffer.from(bytes)),canvas=createCanvas(size.width,size.height),context=canvas.getContext('2d');
  if(image.width!==size.width||image.height!==size.height)throw new PilotError('capture_redaction_failed');
  context.drawImage(image,0,0);context.fillStyle='#000';
  const sx=size.width/geometry.width,sy=size.height/geometry.height;
  for(const mask of geometry.masks){
    if(![mask.x,mask.y,mask.width,mask.height].every(Number.isFinite)||mask.width<0||mask.height<0)throw new PilotError('capture_redaction_failed');
    // Expand a pixel to cover antialiasing and fractional CSS bounds.
    const x=Math.max(0,Math.floor(mask.x*sx)-1),y=Math.max(0,Math.floor(mask.y*sy)-1),right=Math.min(size.width,Math.ceil((mask.x+mask.width)*sx)+1),bottom=Math.min(size.height,Math.ceil((mask.y+mask.height)*sy)+1);
    if(right>x&&bottom>y)context.fillRect(x,y,right-x,bottom-y);
  }
  return canvas.toBuffer('image/png');
}
export async function imagePreview(bytes:Uint8Array){
  const size=imageSize(bytes),{loadImage,createCanvas}=await import('@napi-rs/canvas'),image=await loadImage(Buffer.from(bytes));
  for(const bound of [1024,768,512,256]){
    const scale=Math.min(1,bound/Math.max(size.width,size.height)),width=Math.max(1,Math.floor(size.width*scale)),height=Math.max(1,Math.floor(size.height*scale)),canvas=createCanvas(width,height),context=canvas.getContext('2d');
    context.fillStyle='#fff';context.fillRect(0,0,width,height);context.drawImage(image,0,0,width,height);
    const preview=canvas.toBuffer('image/jpeg',70);if(preview.length<=120000)return {data:preview.toString('base64'),mimeType:'image/jpeg',width,height,originalWidth:size.width,originalHeight:size.height};
  }
  throw new PilotError('image_size_limit');
}
