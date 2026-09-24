import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiExtractor, geminiInquiryReply, geminiInventoryAnswer, inventoryTool, verifyModelProposal, verifyMailProposal } from '../src/model.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { type InquiryCase, type Source } from '../src/domain.js';
const sources:Source[]=[{source:'email',page:0,text:'I am Mia Example from Acme Workshop. Please order 5 FILTER-A10 (Nos), PO ABC-1, delivery 2027-02-20 to 10 Test Road.'}];
const span=(quote:string,value=quote)=>({sourceIndex:0,quote,value});
const facts={facts:{customer:[span('Acme Workshop')],sender:[span('Mia Example')],location:[],po:[span('PO ABC-1','ABC-1')],date:[span('2027-02-20')],address:[span('10 Test Road')]},
  lines:[{description:span('FILTER-A10'),quantity:span('5 FILTER-A10','5'),unit:span('(Nos)','Nos')}]};
test('mail intent is grounded and missing line fields stay unresolved',()=>{
  const raw={...facts,intent:'conditional',intentEvidence:span('Please order'),lines:[{description:span('FILTER-A10'),quantity:null,unit:null}],
    reply:{language:'en'}};
  const result=verifyMailProposal(raw,sources);
  assert.equal(result.intent?.kind,'conditional');assert.equal(result.facts.sender[0].value,'Mia Example');assert.equal(result.lines[0].quantity.value,'');assert.equal(result.lines[0].unit.value,'');
  assert.throws(()=>verifyMailProposal({...raw,intentEvidence:span('invented confirmation')},sources),/MODEL_QUOTE_NOT_FOUND/);
  const spaced=verifyMailProposal({...raw,lines:[{description:span('FILTER-A10'),quantity:span('5FILTER-A10','5'),unit:null}]},sources);
  assert.equal(spaced.lines[0].quantity.value,'5');
  assert.equal(spaced.lines[0].quantity.evidence.start,sources[0].text.indexOf('5'));
});
test('model results become facts only when every quote is grounded in the source',()=>{
  const e=verifyModelProposal(facts,sources);
  assert.equal(e.lines[0].quantity.value,'5');assert.equal(e.lines[0].quantity.evidence.start,sources[0].text.indexOf('5 FILTER-A10'));
  assert.throws(()=>verifyModelProposal({...facts,facts:{...facts.facts,customer:[span('Invisible Customer')]}},sources),/MODEL_QUOTE_NOT_FOUND/);
});
test('repeated exact facts remain grounded at a deterministic source offset',()=>{
  const repeated:Source[]=[{source:'email',page:0,text:'PO ABC-1. PO ABC-1.'}];
  const result=verifyModelProposal({facts:{customer:[],sender:[],location:[],po:[span('PO ABC-1','ABC-1')],date:[],address:[]},lines:[]},repeated);
  assert.equal(result.facts.po[0].value,'ABC-1');
  assert.equal(result.facts.po[0].evidence.start,3);
});
test('mail line fields use their closest grounded combination when individual quotes repeat',()=>{
  const text='Sehr geehrte Damen und Herren, wir sind an einigen Ihrer Produkte interessiert. 15x Smart Thermostat V1 10x Filter A20 5x Thermostat X-200 20x Filter. Lieferung bis 15. Oktober 2026. Mit freundlichen Grüßen Lukas Weber, Weber Gebäudetechnik GmbH';
  const german:Source[]=[{source:'email',page:0,text}];
  const s=(quote:string,value=quote)=>({sourceIndex:0,quote,value});
  const raw={intent:'inquiry',intentEvidence:s('interessiert'),facts:{customer:[s('Weber Gebäudetechnik GmbH')],sender:[s('Lukas Weber')],location:[],po:[],date:[s('15. Oktober 2026')],address:[]},
    lines:[
      {description:s('Smart Thermostat V1'),quantity:s('15'),unit:null},
      {description:s('Filter A20'),quantity:s('10'),unit:null},
      {description:s('Thermostat X-200'),quantity:s('5'),unit:null},
      {description:s('Filter'),quantity:s('20'),unit:null}
    ],reply:{language:'de'}};
  const result=verifyMailProposal(raw,german);
  assert.equal(result.intent?.kind,'inquiry');
  assert.equal(result.lines[0].quantity.evidence.start,text.indexOf('15x'));
  assert.equal(result.lines[3].description.evidence.start,text.lastIndexOf('Filter'));
  assert.equal(result.lines[3].quantity.evidence.start,text.indexOf('20x'));
});
test('repeated sender and company mentions do not invalidate otherwise exact mail evidence',()=>{
  const text='Tallinna Kliimatehnika OÜ. Toomas Tamm, Procurement Manager, Tallinna Kliimatehnika OÜ. We need a non-binding price quote for 10x Filter A20 and 20x Filter. Best regards, Toomas Tamm';
  const mail:Source[]=[{source:'email',page:0,text}];
  const s=(quote:string,value=quote)=>({sourceIndex:0,quote,value});
  const raw={intent:'inquiry',intentEvidence:s('non-binding price quote'),facts:{customer:[s('Tallinna Kliimatehnika OÜ')],sender:[s('Toomas Tamm')],location:[],po:[],date:[],address:[]},
    lines:[{description:s('Filter A20'),quantity:s('10'),unit:null},{description:s('Filter'),quantity:s('20'),unit:null}],
    reply:{language:'en'}};
  const result=verifyMailProposal(raw,mail);
  assert.equal(result.facts.customer[0].evidence.start,0);
  assert.equal(result.facts.sender[0].evidence.start,text.indexOf('Toomas Tamm'));
  assert.equal(result.lines[1].description.evidence.start,text.lastIndexOf('Filter'));
});
test('soft purchase language is deterministically held as conditional with source evidence',()=>{
  const softSources:Source[]=[{source:'email',page:0,text:'We are Messerschmitt & sons from Little Rock, Ohio, USA. We are interested in placing an order of 50 type a10 filters. Best, Gavin Livingson.'}];
  const s=(quote:string,value=quote)=>({sourceIndex:0,quote,value});
  const raw={intent:'purchase',intentEvidence:s('placing an order'),facts:{customer:[s('Messerschmitt & sons')],sender:[s('Gavin Livingson')],
    location:[s('Little Rock, Ohio, USA')],po:[],date:[],address:[]},lines:[{description:s('type a10 filters'),quantity:s('50 type','50'),unit:null}],
    reply:{language:'en'}};
  const result=verifyMailProposal(raw,softSources);
  assert.equal(result.intent?.kind,'conditional');assert.equal(result.intent?.evidence.value,'interested in placing an order');
  assert.equal(result.facts.location[0].value,'Little Rock, Ohio, USA');assert.deepEqual(result.facts.address,[]);assert.equal(result.reply?.language,'en');
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
test('Gemini drafts an inquiry reply from structured ERP results in the requested language',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'gemini-reply-'));
  const originalKey=process.env.GOOGLE_API_KEY, originalTrace=process.env.ORDER_TRACE;
  process.env.GOOGLE_API_KEY='fictional-test-key';process.env.ORDER_TRACE='false';
  let requests=0;
  t.mock.method(globalThis,'fetch',async(url:unknown,init:RequestInit)=>{
    requests++;
    assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent');
    const body=JSON.parse(init.body as string);
    assert.equal(body.tools[0].functionDeclarations[0].name,'draft_inquiry_reply');
    assert.equal(body.toolConfig.functionCallingConfig.mode,'ANY');
    const input=JSON.parse(body.contents[0].parts[0].text);
    assert.equal(input.language,'fi');assert.equal(input.requestedDate,'15. lokakuuta 2026');assert.equal(input.deliveryAddress,'Testikatu 1, Helsinki');
    assert.equal(input.lines[0].availability,'requested-quantity-not-currently-confirmed');assert.equal('inventory' in input.lines[0],false);assert.equal('itemCode' in input.lines[0],false);
    return Response.json({candidates:[{content:{parts:[{functionCall:{name:'draft_inquiry_reply',args:{draft:'Hei Matti,\n\nEmme voi vielä vahvistaa pyydettyä FILTER-A20-määrää. Selvitämme täydennystä ja vaihtoehtoja. Lähetämme hinnan ja toimitusarvion yhtenä tarjouksena.\n\nYstävällisin terveisin,\nMyyntitiimi'}}}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:30}});
  });
  const inquiry:InquiryCase={intent:'inquiry',customerText:'Fictional Oy',senderName:'Matti',customer:'',condition:'saatavuutta',requestedDate:'15. lokakuuta 2026',deliveryAddress:'Testikatu 1, Helsinki',
    lines:[{itemText:'Filter A20',itemCode:'FILTER-A20',quantity:'10',status:'out-of-stock',inventory:{stockTracked:true,totalActualQty:0}}],
    needs:['确认适用价格','确认客户要求的交期能否满足'],replyLanguage:'fi',responseDraft:''};
  try {
    const result=await geminiInquiryReply(dir)(inquiry);
    assert.equal(requests,1);assert.equal(result.language,'fi');assert.equal(result.model,'gemini-2.5-flash-lite');assert.match(result.draft,/Hei Matti/);
    const ledger=SqliteSaver.fromConnString(join(dir,'model-budget.sqlite'));
    try {assert.equal((ledger.db.prepare('SELECT count(*) AS count FROM model_budget').get() as {count:number}).count,1);} finally {ledger.db.close();}
  } finally {
    if(originalKey===undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY=originalKey;
    if(originalTrace===undefined) delete process.env.ORDER_TRACE; else process.env.ORDER_TRACE=originalTrace;
    await rm(dir,{recursive:true,force:true});
  }
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
