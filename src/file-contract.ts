import {z} from 'zod';
import {idSchema} from './shared.js';

export const FILE_CHUNK_BYTES=32*1024;
export const FILE_MAX_BYTES=50*1024*1024;
export const FILE_BATCH_BYTES=100*1024*1024;
export const FILE_TTL_MS=15*60*1000;
export const fileNameSchema=z.string().min(1).max(240).refine(v=>!/[\x00-\x1f\\/:]/.test(v)&&v!=='.'&&v!=='..');
export const fileMetadataSchema=z.object({id:idSchema,name:fileNameSchema,size:z.number().int().min(0).max(FILE_MAX_BYTES),mime:z.string().max(120),sha256:z.string().regex(/^[a-f0-9]{64}$/),expiresAt:z.number().int()}).strict();
export type FileMetadata=z.infer<typeof fileMetadataSchema>;
export const fileBeginSchema=z.object({name:fileNameSchema,size:z.number().int().min(0).max(FILE_MAX_BYTES),mime:z.string().max(120).default('application/octet-stream'),requestId:idSchema.optional()}).strict();
export const fileChunkSchema=z.object({transferId:idSchema,offset:z.number().int().nonnegative(),data:z.string().max(Math.ceil(FILE_CHUNK_BYTES/3)*4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).refine(v=>v.length/4*3-(v.endsWith('==')?2:v.endsWith('=')?1:0)<=FILE_CHUNK_BYTES)}).strict();
export const fileFinishSchema=z.object({transferId:idSchema,sha256:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
export const fileUploadSchema=z.object({targetId:z.string().min(1).max(100),stateVersion:z.string().min(1).max(200),artifactIds:z.array(idSchema).min(1).max(20)}).strict();
export const fileRequestSchema=z.object({purpose:z.string().trim().min(1).max(300),accept:z.string().max(300).default(''),multiple:z.boolean().default(false)}).strict();
export const fileCommands=['browser_files_roots','browser_files_find','browser_files_import','browser_files_begin','browser_files_chunk','browser_files_finish','browser_files_status','browser_files_release','browser_files_request','browser_upload'] as const;
