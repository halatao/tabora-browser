import {z} from 'zod';

export const OBSERVATION_VERSION=2;
const ref=z.string().min(1).max(120);
export const frameRefSchema=z.object({frameId:z.number().int().nonnegative(),documentId:z.string().min(1).max(120),origin:z.string().url().max(2048)}).strict();
export const actionSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('click'),targetId:ref,backend:z.enum(['dom','native']).default('dom')}).strict(),
  z.object({type:z.literal('navigate'),targetId:ref}).strict(),
  z.object({type:z.literal('image_click'),targetId:ref,captureId:z.string().uuid(),x:z.number().int().nonnegative().max(4096),y:z.number().int().nonnegative().max(4096)}).strict(),
  z.object({type:z.literal('fill'),targetId:ref,value:z.string().max(16000),backend:z.enum(['dom','native']).default('dom')}).strict(),
  z.object({type:z.literal('check'),targetId:ref,checked:z.boolean()}).strict(),
  z.object({type:z.literal('select'),targetId:ref,indices:z.array(z.number().int().nonnegative()).max(100)}).strict(),
  z.object({type:z.literal('key'),targetId:ref,key:z.enum(['Enter','Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Backspace','Delete','Space']),shift:z.boolean().default(false)}).strict(),
  z.object({type:z.literal('hover'),targetId:ref}).strict(),
  z.object({type:z.literal('scroll'),targetId:ref,x:z.number().int().min(-2000).max(2000).default(0),y:z.number().int().min(-2000).max(2000)}).strict(),
  z.object({type:z.literal('replace'),targetId:ref,start:z.number().int().nonnegative(),end:z.number().int().nonnegative(),text:z.string().max(16000)}).strict().refine(a=>a.end>=a.start),
  z.object({type:z.literal('drag'),targetId:ref,destinationId:ref}).strict(),
]);
export type BrowserAction=z.infer<typeof actionSchema>;
export const dialogSchema=z.object({type:z.enum(['alert','confirm']),message:z.string().min(1).max(1000),accept:z.boolean()}).strict();
export type ExpectedDialog=z.infer<typeof dialogSchema>;
export const outcomePredicate=z.discriminatedUnion('type',[
  z.object({type:z.literal('text'),targetId:ref,contains:z.string().min(1).max(2000)}).strict(),
  z.object({type:z.literal('value'),targetId:ref,equals:z.string().max(16000)}).strict(),
  z.object({type:z.literal('checked'),targetId:ref,equals:z.boolean()}).strict(),
  z.object({type:z.literal('url'),equals:z.string().url().max(2048)}).strict(),
]);
export type OutcomePredicate=z.infer<typeof outcomePredicate>;
export const capabilityStatus=z.enum(['available','permission_required','unsupported','experimental']);
export const capabilityResult=z.object({schemaVersion:z.literal(2),capabilities:z.record(z.string(),z.object({status:capabilityStatus,reason:z.string().max(240).optional()}).strict())}).strict();
export type TargetV2={
  id:string;kind:string;role:string;name:string;description?:string;section?:string;recordKey?:string;
  disabled:boolean;readonly:boolean;visible:boolean;checked?:boolean|'mixed';expanded?:boolean;selected?:boolean;
  value?:string;inputType?:string;inputPurpose?:'username'|'current-password'|'new-password'|'one-time-code';secret?:boolean;accept?:string;multiple?:boolean;href?:string;clickable?:boolean;draggable?:boolean;submitter?:boolean;formValid?:boolean;
  options?:{index:number;label:string;selected:boolean;disabled:boolean}[];optionCount?:number;
  rowCount?:number;columnCount?:number;totalRows?:number;virtualized?:boolean;scrollable?:boolean;scroll?:{x:number;y:number;maxX:number;maxY:number;viewportWidth?:number;viewportHeight?:number};
};
export type ObservationV2={
  schemaVersion:2;snapshotId:string;epoch:number;dataVersion?:string;origin:string;path:string;title:string;targets:TargetV2[];
  coverage:{scanned:number;targetCount:number;truncated:boolean;cursor:number;nextCursor:number|null};
  provenance:{source:'page';trust:'untrusted';documentToken:string};
};
export type ObservationDelta={schemaVersion:2;snapshotId:string;baseSnapshotId:string;epoch:number;added:TargetV2[];changed:TargetV2[];removed:string[];coverage:ObservationV2['coverage'];provenance:ObservationV2['provenance']};
export type ReaderResult={schemaVersion:2;text?:string;rows?:string[][];offset:number;nextOffset:number|null;complete:boolean;truncated:boolean;observedRows?:number;totalRows?:number;provenance:ObservationV2['provenance']&{targetId:string;origin:string;path:string}};

export function observationDiff(previous:ObservationV2,current:ObservationV2):ObservationDelta{
  const before=new Map(previous.targets.map(t=>[t.id,t])),after=new Map(current.targets.map(t=>[t.id,t]));
  return {schemaVersion:2,snapshotId:current.snapshotId,baseSnapshotId:previous.snapshotId,epoch:current.epoch,
    added:current.targets.filter(t=>!before.has(t.id)),changed:current.targets.filter(t=>before.has(t.id)&&JSON.stringify(before.get(t.id))!==JSON.stringify(t)),
    removed:previous.targets.filter(t=>!after.has(t.id)).map(t=>t.id),coverage:current.coverage,provenance:current.provenance};
}
