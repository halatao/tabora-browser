import test from 'node:test';import assert from 'node:assert/strict';import {siteArguments,validateSiteSchema} from '../src/site-schema.js';
test('experimental site arguments refuse unknown fields, references and unbounded machinery',()=>{
  const schema={type:'object',properties:{name:{type:'string',maxLength:20},count:{type:'integer',minimum:0}},required:['name'],additionalProperties:false};
  siteArguments(schema,{name:'Allowed',count:2});assert.throws(()=>siteArguments(schema,{name:'x',url:'https://evil.test'}),/invalid_site_arguments/);assert.throws(()=>siteArguments({...schema,$ref:'https://evil.test/schema'},{name:'x'}),/unsupported_site_schema/);assert.throws(()=>siteArguments(schema,{name:'x',count:1.1}),/invalid_site_arguments/);assert.throws(()=>siteArguments(schema,{name:'x'.repeat(21)}),/invalid_site_arguments/);
});
test('discovery rejects unsupported schemas in optional fields before any invocation',()=>{
  assert.throws(()=>validateSiteSchema({$ref:'https://external.invalid/schema'}),/unsupported_site_schema/);
  assert.throws(()=>validateSiteSchema({type:'object',properties:{optional:{$ref:'https://external.invalid/schema'}}}),/unsupported_site_schema/);
  assert.throws(()=>siteArguments({type:'object',properties:{optional:{oneOf:[{type:'string'}]}}},{}),/unsupported_site_schema/);
  assert.throws(()=>validateSiteSchema({type:'string',maxLength:'unbounded'}),/unsupported_site_schema/);
  assert.deepEqual(validateSiteSchema(JSON.stringify({type:'object',properties:{}})),{type:'object',properties:{}});
});
