export type LoadedRecord={key:string|null;index:string|null;text:string;fields:{name:string;value:string}[]};
export type RecordCollection={total:number;records:Map<string,LoadedRecord>};
/** Validate the entire new range before replacing collection state. */
export function collectRecords(previous:RecordCollection|undefined,records:LoadedRecord[],total:number):RecordCollection{
  if(!Number.isInteger(total)||total<1||total>2000||records.length>total)throw Error('collection_identity_required');
  if(previous&&previous.total!==total)throw Error('collection_changed');
  const merged=new Map(previous?.records),keys=new Set<string>();
  for(const record of records){
    if(!record.key||keys.has(record.key)||!record.index||!(/^[1-9]\d*$/.test(record.index))||Number(record.index)>total)throw Error('collection_identity_required');keys.add(record.key);
    if(JSON.stringify(record).length>16000)throw Error('record_exceeds_budget');const old=merged.get(record.key);if(old&&JSON.stringify(old)!==JSON.stringify(record))throw Error('collection_changed');merged.set(record.key,record);
  }
  const indices=new Set<string>();let budget=1000000;
  for(const record of merged.values()){if(indices.has(record.index!))throw Error('collection_changed');indices.add(record.index!);budget-=JSON.stringify(record).length;if(budget<0)throw Error('collection_limit');}
  if(merged.size>total)throw Error('collection_limit');return {total,records:merged};
}
