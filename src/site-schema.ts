/** Conservative local subset for experimental site tools. Unknown schema machinery fails closed. */
export function normalizeSiteSchema(schema:unknown){if(schema===undefined)return {type:'object',properties:{},additionalProperties:false};if(typeof schema!=='string')return schema;if(schema.length>12000)throw Error('unsupported_site_schema');try{return JSON.parse(schema);}catch{throw Error('unsupported_site_schema');}}
export function validateSiteSchema(input:unknown,depth=0):unknown{
  const schema=depth===0?normalizeSiteSchema(input):input;
  if(depth>6||!schema||typeof schema!=='object'||Array.isArray(schema)||JSON.stringify(schema).length>12000)throw Error('unsupported_site_schema');
  const value=schema as Record<string,any>,allowed=new Set(['type','properties','required','additionalProperties','items','minItems','maxItems','minLength','maxLength','minimum','maximum','enum','description','title']);
  if(Object.keys(value).some(key=>!allowed.has(key))||!['object','array','string','number','integer','boolean','null'].includes(value.type))throw Error('unsupported_site_schema');
  if(value.enum!==undefined&&(!Array.isArray(value.enum)||value.enum.length>100))throw Error('unsupported_site_schema');
  for(const key of ['minItems','maxItems','minLength','maxLength'])if(value[key]!==undefined&&(!Number.isSafeInteger(value[key])||value[key]<0))throw Error('unsupported_site_schema');
  for(const key of ['minimum','maximum'])if(value[key]!==undefined&&(typeof value[key]!=='number'||!Number.isFinite(value[key])))throw Error('unsupported_site_schema');
  if(value.type==='object'){
    const properties=value.properties??{};if(!properties||typeof properties!=='object'||Array.isArray(properties)||Object.keys(properties).length>50||value.additionalProperties!==undefined&&typeof value.additionalProperties!=='boolean'||value.required!==undefined&&(!Array.isArray(value.required)||value.required.some((key:unknown)=>typeof key!=='string'||!Object.hasOwn(properties,key))))throw Error('unsupported_site_schema');
    for(const property of Object.values(properties))validateSiteSchema(property,depth+1);
  }
  if(value.type==='array')validateSiteSchema(value.items,depth+1);
  return schema;
}
export function siteArguments(schema:any,value:unknown,depth=0):void{
  if(depth===0)schema=validateSiteSchema(schema);
  if(depth>6||!schema||typeof schema!=='object'||Array.isArray(schema)||JSON.stringify(schema).length>12000)throw Error('unsupported_site_schema');
  const allowed=new Set(['type','properties','required','additionalProperties','items','minItems','maxItems','minLength','maxLength','minimum','maximum','enum','description','title']);
  if(Object.keys(schema).some(key=>!allowed.has(key)))throw Error('unsupported_site_schema');
  if(schema.enum&&(!Array.isArray(schema.enum)||schema.enum.length>100||!schema.enum.some((candidate:unknown)=>JSON.stringify(candidate)===JSON.stringify(value))))throw Error('invalid_site_arguments');
  if(schema.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid_site_arguments');
    const properties=schema.properties??{},required=schema.required??[];
    if(Object.keys(properties).length>50||!Array.isArray(required)||required.some((key:unknown)=>typeof key!=='string'))throw Error('unsupported_site_schema');
    if(Object.keys(value).some(key=>!Object.hasOwn(properties,key))||required.some((key:string)=>!Object.hasOwn(value,key)))throw Error('invalid_site_arguments');
    for(const [key,item] of Object.entries(value))siteArguments(properties[key],item,depth+1);
  }else if(schema.type==='array'){
    if(!Array.isArray(value)||value.length>Math.min(schema.maxItems??20,20)||value.length<(schema.minItems??0))throw Error('invalid_site_arguments');for(const item of value)siteArguments(schema.items,item,depth+1);
  }else if(schema.type==='string'){
    if(typeof value!=='string'||value.length>Math.min(schema.maxLength??2000,2000)||value.length<(schema.minLength??0))throw Error('invalid_site_arguments');
  }else if(schema.type==='number'||schema.type==='integer'){
    if(typeof value!=='number'||!Number.isFinite(value)||schema.type==='integer'&&!Number.isSafeInteger(value)||value<(schema.minimum??-Number.MAX_SAFE_INTEGER)||value>(schema.maximum??Number.MAX_SAFE_INTEGER))throw Error('invalid_site_arguments');
  }else if(schema.type==='boolean'){if(typeof value!=='boolean')throw Error('invalid_site_arguments');}
  else if(schema.type==='null'){if(value!==null)throw Error('invalid_site_arguments');}
  else throw Error('unsupported_site_schema');
}
