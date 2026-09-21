import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiExtractor, geminiInventoryAnswer, inventoryTool, verifyModelProposal } from '../src/model.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Source } from '../src/domain.js';
const sources:Source[]=[{source:'email',page:0,text:'Please order 5 FILTER-A10 (Nos) for Acme Workshop, PO ABC-1, delivery 2027-02-20 to 10 Test Road.'}];
const span=(quote:string,value=quote)=>({sourceIndex:0,quote,value});
const facts={facts:{customer:[span('Acme Workshop')],po:[span('PO ABC-1','ABC-1')],date:[span('2027-02-20')],address:[span('10 Test Road')]},
  lines:[{description:span('FILTER-A10'),quantity:span('5 FILTER-A10','5'),unit:span('(Nos)','Nos')}]};
test('model results become facts only when every quote is grounded in the source',()=>{
  const e=verifyModelProposal(facts,sources);
  assert.equal(e.lines[0].quantity.value,'5');assert.equal(e.lines[0].quantity.evidence.start,sources[0].text.indexOf('5 FILTER-A10'));
  assert.throws(()=>verifyModelProposal({...facts,facts:{...facts.facts,customer:[span('Invisible Customer')]}},sources),/MODEL_QUOTE_NOT_UNIQUE/);
});
test('ambiguous repeated quotes cannot be silently grounded',()=>{
  const repeated:Source[]=[{source:'email',page:0,text:'PO ABC-1. PO ABC-1.'}];
  assert.throws(()=>verifyModelProposal({...facts,facts:{...facts.facts,po:[span('PO ABC-1','ABC-1')]}},repeated),/MODEL_QUOTE_NOT_UNIQUE/);
});
test('inventory tool is read-only and preserves unavailable stock as unknown',async()=>{
  let requested='';
  const inventory=inventoryTool({inventory:async(itemCode:string)=>{
    requested=itemCode;
    return {itemCode,itemName:'Filter A10',stockTracked:false,totalActualQty:null,warehouses:[]};
  }});
  const result=await inventory.invoke({itemCode:'FILTER-A10'});
  assert.equal(requested,'FILTER-A10');
  assert.deepEqual(result,{itemCode:'FILTER-A10',itemName:'Filter A10',stockTracked:false,totalActualQty:null,warehouses:[]});
});
test('both model paths use only Gemini 2.5 Flash-Lite, native tools and shared request limit',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'gemini-policy-'));
  const originalKey=process.env.GOOGLE_API_KEY, originalTrace=process.env.ORDER_TRACE;
  process.env.GOOGLE_API_KEY='fictional-test-key'; process.env.ORDER_TRACE='false';
  let requests=0;
  t.mock.method(globalThis,'fetch',async(url:unknown,init:RequestInit)=>{
    assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent');
    assert.equal((init.headers as Record<string,string>)['x-goog-api-key'],'fictional-test-key');
    const body=JSON.parse(init.body as string);
    assert.equal(body.generationConfig.thinkingConfig.thinkingBudget,0);
    assert.equal(body.model,undefined);
    requests++;
    const name=body.tools?.[0]?.functionDeclarations?.[0]?.name;
    if(name) assert.equal(body.toolConfig.functionCallingConfig.mode,'ANY');
    else assert.equal(body.contents[2].parts[0].functionResponse.name,'get_inventory');
    return Response.json({candidates:[{content:{parts:name
      ?[{functionCall:{name,args:name==='extract_order'?facts:{itemCode:'FILTER-A10'}}}]
      :[{text:'ERP does not track inventory quantity for FILTER-A10.'}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:20}});
  });
  try {
    assert.equal((await geminiExtractor(join(dir,'extraction'))(sources)).lines[0].quantity.value,'5');
    const erp={inventory:async(itemCode:string)=>({itemCode,itemName:'Filter A10',stockTracked:false,totalActualQty:null,warehouses:[]})};
    const result=await geminiInventoryAnswer('Fictional FILTER-A10 inventory?',erp,join(dir,'inventory'));
    assert.equal(result.model,'gemini-2.5-flash-lite');
    assert.equal(result.toolResult.totalActualQty,null);
    assert.match(result.answer,/does not track/);
    assert.equal(result.estimatedCostUSD,0.000036);
    await assert.rejects(()=>geminiExtractor(join(dir,'inventory'))(sources),/MODEL_BUDGET_EXHAUSTED/);
    assert.equal(requests,3);
  } finally {
    if(originalKey===undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY=originalKey;
    if(originalTrace===undefined) delete process.env.ORDER_TRACE; else process.env.ORDER_TRACE=originalTrace;
    await rm(dir,{recursive:true,force:true});
  }
});
