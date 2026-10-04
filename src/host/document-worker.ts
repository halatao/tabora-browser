import {parentPort,workerData as threadData} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {imageSize} from '../image-size.js';
const require=createRequire(import.meta.url);
const workerData=threadData??await new Promise<any>(resolve=>process.once('message',resolve));
function reply(value:unknown){if(parentPort)parentPort.postMessage(value);else process.send?.(value,()=>process.disconnect());}
async function ocr(bytes:Uint8Array){
  const {createWorker}=await import('tesseract.js'),data=require('@tesseract.js-data/eng');
  const worker=await createWorker('eng',1,{langPath:data.langPath,gzip:true,cacheMethod:'none',logger:()=>{},errorHandler:()=>{}});
  try{const result=await worker.recognize(Buffer.from(bytes));return {text:result.data.text,confidence:result.data.confidence,precision:'ocr_estimated'};}
  finally{await worker.terminate();}
}
try{
  const bytes=new Uint8Array(workerData.bytes);let result:any;
  if(workerData.format==='ocr'){
    imageSize(bytes);
    // Decode locally with an explicit pixel limit before the OCR worker can allocate a huge image.
    const canvas=require('@napi-rs/canvas'),image=await canvas.loadImage(Buffer.from(bytes));
    if(image.width*image.height>16000000||image.width>4096||image.height>4096)throw Error('image_size_limit');
    result=await ocr(bytes);
  }else if(workerData.format==='pdf'){
    if(Buffer.from(bytes.subarray(0,5)).toString()!=='%PDF-')throw Error('invalid_pdf');
    const pdf=await import('pdfjs-dist/legacy/build/pdf.mjs');
    // PDF.js 6 removed the old generated-code/eval path. No PDF scripting manager is loaded.
    const loading=pdf.getDocument({data:bytes,disableFontFace:true,useSystemFonts:false,useWorkerFetch:false,enableXfa:false,stopAtErrors:true,maxImageSize:16000000,verbosity:0});
    const document=await loading.promise;
    try{
      const pageNumber=workerData.page;if(pageNumber<1||pageNumber>document.numPages)throw Error('invalid_pdf_page');
      const page=await document.getPage(pageNumber),content=await page.getTextContent({disableNormalization:true});
      const text=content.items.map((item:any)=>(item.str??'')+(item.hasEOL?'\n':' ')).join('').trimEnd();
      result={text,page:pageNumber,pageCount:document.numPages,precision:'pdf_text',needsOCR:!text.trim()};
      if(workerData.layout){let budget=8000;const items=[];for(const item of content.items as any[]){if(typeof item.str!=='string')continue;const record={text:item.str,x:item.transform[4],y:item.transform[5],width:item.width,height:item.height,direction:item.dir,endOfLine:!!item.hasEOL};const size=JSON.stringify(record).length;if(size>budget)break;budget-=size;items.push(record);}result.layout={items,complete:items.length===content.items.filter((item:any)=>typeof item.str==='string').length,precision:'pdf_positions_not_inferred_table',coordinateSystem:'page_bottom_left'};}
      if(!text.trim()&&workerData.ocr){
        const viewport=page.getViewport({scale:1.5});if(viewport.width*viewport.height>16000000)throw Error('image_size_limit');
        const canvas=require('@napi-rs/canvas').createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
        await page.render({canvas,canvasContext:canvas.getContext('2d') as any,viewport}).promise;
        result={...result,...await ocr(canvas.toBuffer('image/png')),needsOCR:false};
      }
      page.cleanup();
    }finally{await loading.destroy();}
  }else throw Error('unsupported_document');
  if(result.text.length>1000000)throw Error('document_text_limit');
  const revision=createHash('sha256').update(result.text).digest('hex');
  if(workerData.revision&&workerData.revision!==revision)throw Error('reader_changed');
  if(result.precision==='ocr_estimated')result={...result,requiresReview:result.confidence<80,exact:false};
  const total=result.text.length,end=Math.min(total,workerData.offset+workerData.limit);
  result=workerData.fullText?{...result,revision}:{...result,text:result.text.slice(workerData.offset,end),revision,offset:workerData.offset,nextOffset:end<total?end:null,complete:end>=total,truncated:end<total};
  reply({ok:true,result});
}catch(error){const code=error instanceof Error&&error.name==='PasswordException'?'document_password_required':error instanceof Error&&/^[a-z_]+$/.test(error.message)?error.message:'document_parse_failed';reply({ok:false,code});}
