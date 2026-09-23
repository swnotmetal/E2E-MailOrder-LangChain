import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiExtractor, geminiInventoryAnswer, inventoryTool, verifyModelProposal, verifyMailProposal } from '../src/model.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { type Source } from '../src/domain.js';
const sources:Source[]=[{source:'email',page:0,text:'I am Mia Example from Acme Workshop. Please order 5 FILTER-A10 (Nos), PO ABC-1, delivery 2027-02-20 to 10 Test Road.'}];
const span=(quote:string,value=quote)=>({sourceIndex:0,quote,value});
const facts={facts:{customer:[span('Acme Workshop')],sender:[span('Mia Example')],location:[],po:[span('PO ABC-1','ABC-1')],date:[span('2027-02-20')],address:[span('10 Test Road')]},
  lines:[{description:span('FILTER-A10'),quantity:span('5 FILTER-A10','5'),unit:span('(Nos)','Nos')}]};
test('mail intent is grounded and missing line fields stay unresolved',()=>{
  const raw={...facts,intent:'conditional',intentEvidence:span('Please order'),lines:[{description:span('FILTER-A10'),quantity:null,unit:null}],
    reply:{language:'en',draft:'Hello Mia, we are checking availability, price, and delivery timing.'}};
  const result=verifyMailProposal(raw,sources);
  assert.equal(result.intent?.kind,'conditional');assert.equal(result.facts.sender[0].value,'Mia Example');assert.equal(result.lines[0].quantity.value,'');assert.equal(result.lines[0].unit.value,'');
  assert.throws(()=>verifyMailProposal({...raw,intentEvidence:span('invented confirmation')},sources),/MODEL_QUOTE_NOT_UNIQUE/);
  const spaced=verifyMailProposal({...raw,lines:[{description:span('FILTER-A10'),quantity:span('5FILTER-A10','5'),unit:null}]},sources);
  assert.equal(spaced.lines[0].quantity.value,'5');
  assert.equal(spaced.lines[0].quantity.evidence.start,sources[0].text.indexOf('5'));
});
test('model results become facts only when every quote is grounded in the source',()=>{
  const e=verifyModelProposal(facts,sources);
  assert.equal(e.lines[0].quantity.value,'5');assert.equal(e.lines[0].quantity.evidence.start,sources[0].text.indexOf('5 FILTER-A10'));
  assert.throws(()=>verifyModelProposal({...facts,facts:{...facts.facts,customer:[span('Invisible Customer')]}},sources),/MODEL_QUOTE_NOT_UNIQUE/);
});
test('ambiguous repeated quotes cannot be silently grounded',()=>{
  const repeated:Source[]=[{source:'email',page:0,text:'PO ABC-1. PO ABC-1.'}];
  assert.throws(()=>verifyModelProposal({...facts,facts:{...facts.facts,po:[span('PO ABC-1','ABC-1')]}},repeated),/MODEL_QUOTE_NOT_UNIQUE/);
});
test('soft purchase language is deterministically held as conditional with source evidence',()=>{
  const softSources:Source[]=[{source:'email',page:0,text:'We are Messerschmitt & sons from Little Rock, Ohio, USA. We are interested in placing an order of 50 type a10 filters. Best, Gavin Livingson.'}];
  const s=(quote:string,value=quote)=>({sourceIndex:0,quote,value});
  const raw={intent:'purchase',intentEvidence:s('placing an order'),facts:{customer:[s('Messerschmitt & sons')],sender:[s('Gavin Livingson')],
    location:[s('Little Rock, Ohio, USA')],po:[],date:[],address:[]},lines:[{description:s('type a10 filters'),quantity:s('50 type','50'),unit:null}],
    reply:{language:'en',draft:'Hello Gavin, we are checking availability, price, and delivery timing.'}};
  const result=verifyMailProposal(raw,softSources);
  assert.equal(result.intent?.kind,'conditional');assert.equal(result.intent?.evidence.value,'interested in placing an order');
  assert.equal(result.facts.location[0].value,'Little Rock, Ohio, USA');assert.deepEqual(result.facts.address,[]);assert.equal(result.reply?.language,'en');
  assert.throws(()=>verifyMailProposal({...raw,reply:{language:'en',draft:'Visit https://example.com'}},softSources),/Reply must not contain links/);
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
test('Gemini paths preserve history without a local cap and stop on quota errors',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'gemini-policy-'));
  const originalKey=process.env.GOOGLE_API_KEY, originalTrace=process.env.ORDER_TRACE;
  process.env.GOOGLE_API_KEY='fictional-test-key'; process.env.ORDER_TRACE='false';
  let requests=0;
  let quotaError=false;
  t.mock.method(globalThis,'fetch',async(url:unknown,init:RequestInit)=>{
    assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent');
    assert.equal((init.headers as Record<string,string>)['x-goog-api-key'],'fictional-test-key');
    const body=JSON.parse(init.body as string);
    assert.equal(body.generationConfig.thinkingConfig.thinkingBudget,0);
    assert.equal(body.model,undefined);
    requests++;
    if(quotaError) return new Response('{}',{status:429});
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
    const ledger=SqliteSaver.fromConnString(join(dir,'inventory','model-budget.sqlite'));
    try {
      ledger.db.prepare('UPDATE model_budget SET reserved_usd_micro=25000').run();
      assert.equal((await geminiExtractor(join(dir,'inventory'))(sources)).lines[0].quantity.value,'5');
      assert.equal(requests,4);
      quotaError=true;
      await assert.rejects(()=>geminiExtractor(join(dir,'inventory'))(sources),/GEMINI_HTTP_429/);
      assert.equal(requests,5); // No automatic retry or provider fallback.
      const rows=ledger.db.prepare('SELECT reserved_usd_micro, actual_usd_micro FROM model_budget ORDER BY id').all() as {reserved_usd_micro:number;actual_usd_micro:number|null}[];
      assert.deepEqual(rows.map(r=>r.reserved_usd_micro),[25000,25000,0,0]);
      assert.equal(rows[3].actual_usd_micro,null); // Failed request remains recorded; cost unknown.
    } finally {ledger.db.close();}
  } finally {
    if(originalKey===undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY=originalKey;
    if(originalTrace===undefined) delete process.env.ORDER_TRACE; else process.env.ORDER_TRACE=originalTrace;
    await rm(dir,{recursive:true,force:true});
  }
});
