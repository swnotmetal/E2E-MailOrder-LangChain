import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { Command } from '@langchain/langgraph';
import { readSources, templateExtractor, verifyEvidence } from '../src/input.js';
import { workflow } from '../src/workflow.js';
import { FrappeERP } from '../src/erp.js';
import { validate, type Decision, type InquiryDecision } from '../src/domain.js';
import { mockERP } from './mock-erp.js';

async function setup() {
  const mock=await mockERP(); const dir=await mkdtemp(join(tmpdir(),'order-review-'));
  const saver=SqliteSaver.fromConnString(join(dir,'checkpoints.sqlite'));
  const erp=new FrappeERP(mock.url,'token test:test','Nordic Parts Demo',1000);
  return {mock,saver,erp,dir,graph:workflow(erp,saver),close:async()=>{saver.db.close();await mock.close();await rm(dir,{recursive:true,force:true});}};
}
const config=(id='test')=>({configurable:{thread_id:id}});
async function sources(name='01-clean') {return readSources(`fixtures/${name}.eml`,`fixtures/${name}.pdf`);}
function approve(s:Record<string,any>,overrides:Partial<Decision>={}) {return {action:'approve',revision:s.revision,actor:'test-operator',reason:'Manually checked development fixture',draft:s.draft,...overrides};}

test('PDF extraction preserves exact source offsets; forged evidence rejected',async()=>{
  const input=await sources(),e=await templateExtractor(input);
  assert.equal(e.facts.po.length,2);assert.equal(e.lines.length,2);verifyEvidence(e,input);
  e.facts.po[0].evidence.quote='forged';assert.throws(()=>verifyEvidence(e,input),/INVALID_EVIDENCE/);
});
test('clean order interrupts before HTTP write then creates a draft',async()=>{
  const x=await setup();try {
    await x.graph.invoke({sources:await sources()},config());
    let s=await x.graph.getState(config());assert.equal(x.mock.posts,0);assert.equal(s.tasks[0].interrupts.length,1);assert.deepEqual(s.values.issues,[]);
    await x.graph.invoke(new Command({resume:approve(s.values)}),config());
    s=await x.graph.getState(config());assert.equal(s.values.status,'created');assert.equal(x.mock.orders[0].docstatus,0);
  }finally{await x.close();}
});
test('ambiguous description stays unresolved and approval loops back',async()=>{
  const x=await setup();try {
    await x.graph.invoke({sources:await sources('02-ambiguous')},config());const s=await x.graph.getState(config());
    assert.equal(s.values.draft.lines[0].item,'');assert.ok(s.values.items.some((i:any)=>i.name==='FILTER-A10'));assert.ok(s.values.items.some((i:any)=>i.name==='FILTER-A20'));
    await x.graph.invoke(new Command({resume:approve(s.values)}),config());assert.equal(x.mock.posts,0);assert.equal((await x.graph.getState(config())).values.status,'review');
  }finally{await x.close();}
});
test('quantity conflict needs an explicit reason; corrected decision persists audit',async()=>{
  const x=await setup();try {
    await x.graph.invoke({sources:await sources('03-quantity-conflict')},config());const s=await x.graph.getState(config());
    assert.ok(s.values.issues.some((i:any)=>i.code==='LINE_CONFLICT'));
    await x.graph.invoke(new Command({resume:approve(s.values,{reason:''})}),config());
    const paused=await x.graph.getState(config());assert.match((paused.tasks[0].interrupts[0].value as any).feedback,/RESOLUTION_REASON_REQUIRED/);
    await x.graph.invoke(new Command({resume:approve(s.values)}),config());
    assert.equal((await x.graph.getState(config())).values.audit.length,1);assert.equal(x.mock.posts,1);
  }finally{await x.close();}
});
test('same PO with identical data across threads creates only one order',async()=>{
  const x=await setup();try {
    for(const id of ['first','second']) {
      await x.graph.invoke({sources:await sources()},config(id));const s=await x.graph.getState(config(id));
      await x.graph.invoke(new Command({resume:approve(s.values)}),config(id));
    }
    assert.equal(x.mock.posts,1);
  }finally{await x.close();}
});
test('timeout after commit reconciles; concurrent writes honor ERP unique key',async()=>{
  const x=await setup();try {
    await x.graph.invoke({sources:await sources()},config());const s=await x.graph.getState(config());x.mock.timeout();
    const result=await Promise.all([x.erp.createDraft(s.values.draft),x.erp.createDraft(s.values.draft)]);
    assert.equal(result[0].name,result[1].name);assert.equal(x.mock.posts,1);
  }finally{await x.close();}
});
test('missing date, address mismatch, unknown customer and invalid quantities are blocked',async()=>{
  const x=await setup();try {
    for(const name of ['06-missing-date','07-address-mismatch','08-unknown-customer','09-invalid-quantity']) {
      await x.graph.invoke({sources:await sources(name)},config(name));let s=await x.graph.getState(config(name));assert.ok(s.values.issues.length);
      await x.graph.invoke(new Command({resume:approve(s.values)}),config(name));s=await x.graph.getState(config(name));assert.equal(s.values.status,'review');
    }
    assert.equal(x.mock.posts,0);
  }finally{await x.close();}
});
test('checkpoint reopened after connection closes resumes at approval',async()=>{
  const x=await setup();try {
    await x.graph.invoke({sources:await sources()},config());x.saver.db.close();
    x.saver=SqliteSaver.fromConnString(join(x.dir,'checkpoints.sqlite'));x.graph=workflow(x.erp,x.saver);
    const s=await x.graph.getState(config());await x.graph.invoke(new Command({resume:approve(s.values)}),config());
    assert.equal((await x.graph.getState(config())).values.status,'created');assert.equal(x.mock.posts,1);x.saver.db.close();
  }finally{await x.close();}
});
test('stale review rejected; request-info and rejection never write',async()=>{
  const x=await setup();try {
    await x.graph.invoke({sources:await sources()},config('stale'));const s=await x.graph.getState(config('stale'));
    await x.graph.invoke(new Command({resume:approve(s.values,{revision:'old'})}),config('stale'));
    assert.match(((await x.graph.getState(config('stale'))).tasks[0].interrupts[0].value as any).feedback,/STALE_APPROVAL/);
    await x.graph.invoke({sources:await sources()},config('info'));let q=await x.graph.getState(config('info'));
    await x.graph.invoke(new Command({resume:approve(q.values,{action:'request-info'})}),config('info'));q=await x.graph.getState(config('info'));assert.equal(q.values.status,'needs-info');
    await x.graph.invoke(new Command({resume:approve(q.values,{action:'reject'})}),config('info'));assert.equal((await x.graph.getState(config('info'))).values.status,'rejected');assert.equal(x.mock.posts,0);
  }finally{await x.close();}
});
test('ERP unavailable leaves a retryable checkpoint',async()=>{
  const x=await setup();try {
    x.mock.failReads(true);await assert.rejects(x.graph.invoke({sources:await sources()},config()),/ERP_HTTP_503/);
    x.mock.failReads(false);await x.graph.invoke(null,config());assert.equal((await x.graph.getState(config())).values.status,'review');
  }finally{await x.close();}
});
test('deterministic quantity/date bounds',()=>{
  const d={customer:'ACME',po:'x',date:'2027-02-30',address:'a',lines:[{description:'x',item:'x',quantity:'1.5',unit:'Nos'}]};
  assert.deepEqual(validate(d).map(i=>i.code),['INVALID_DATE','INVALID_QUANTITY']);
});


test('field values that repeat label names still have exact offsets',async()=>{
  const input=[{source:'email' as const,page:0,text:'Customer: Customer\nPO: PO\nItem: Item | 2 | Nos\n'}];
  const e=await templateExtractor(input);verifyEvidence(e,input);assert.equal(e.facts.customer[0].value,'Customer');
});
test('fixture-backed ERP isolates addresses, stock states and historical customer PO',async()=>{
  const x=await setup();try {
    assert.deepEqual((await x.erp.addresses('KRASOVEC')).map(a=>a.name),['KRASOVEC-SHIPPING']);
    assert.equal((await x.erp.inventory('FILTER-A10')).totalActualQty,12);
    assert.equal((await x.erp.inventory('FILTER-A20')).totalActualQty,0);
    assert.equal((await x.erp.inventory('NON-STOCK-01')).totalActualQty,null);
    const history={customer:'ACME',po:'CUST-PO-999',date:'2027-02-20',address:'ACME-SHIPPING',lines:[{description:'Filter A10',item:'FILTER-A10',quantity:'1',unit:'Nos'}]};
    assert.equal((await x.erp.duplicates(history)).length,1);
  }finally{await x.close();}
});
test('inquiry and conditional intents use reply review without order validation or ERP writes',async()=>{
  for(const kind of ['inquiry','conditional','unclear'] as const){
    const x=await setup();try{
      const graph=workflow(x.erp,x.saver,async input=>{const e=await templateExtractor(input);return {...e,intent:{kind,evidence:e.facts.po[0]}};});
      await graph.invoke({sources:await sources()},config());
      const s=await graph.getState(config());
      assert.equal(s.values.status,'inquiry-review');assert.deepEqual(s.values.issues,[]);
      assert.equal(s.values.inquiry.lines[0].itemCode,'FILTER-A10');assert.equal(s.values.inquiry.lines[0].inventory.totalActualQty,12);
      assert.match(s.values.inquiry.responseDraft,/recorded ERP stock is 12/);
      assert.match(s.values.inquiry.responseDraft,/Prices and your requested delivery date still need human confirmation/);
      assert.doesNotMatch(s.values.inquiry.responseDraft,/No order has been created/);
      assert.equal((s.tasks[0].interrupts[0].value as any).kind,'inquiry');
      const decision:InquiryDecision={action:'approve-reply',revision:s.values.revision,actor:'test-operator',reason:'Checked fictional reply',responseDraft:s.values.inquiry.responseDraft};
      await graph.invoke(new Command({resume:decision}),config());
      assert.equal((await graph.getState(config())).values.status,'response-approved');assert.equal(x.mock.posts,0);
    }finally{await x.close();}
  }
});
test('a unique model token maps conversational A10 text without weakening generic ambiguity',async()=>{
  const x=await setup();try{
    const text='We are interested in 50 type a10 filters.';
    const fact=(value:string)=>{const start=text.indexOf(value);return {value,evidence:{source:'email' as const,page:0,start,end:start+value.length,quote:value}};};
    const empty={value:'',evidence:{source:'email' as const,page:0,start:0,end:0,quote:''}};
    const input=[{source:'email' as const,page:0,text}];
    const graph=workflow(x.erp,x.saver,async()=>({facts:{customer:[],sender:[],location:[],po:[],date:[],address:[]},
      intent:{kind:'conditional' as const,evidence:fact('interested')},lines:[{description:fact('type a10 filters'),quantity:fact('50'),unit:empty}]}));
    await graph.invoke({sources:input},config('model-token'));
    const s=await graph.getState(config('model-token'));
    assert.equal(s.values.inquiry.lines[0].itemCode,'FILTER-A10');assert.equal(s.values.status,'inquiry-review');assert.equal(x.mock.posts,0);
  }finally{await x.close();}
});
test('inquiry fallback reply follows a Chinese customer message',async()=>{
  const x=await setup();try{
    const text='您好，我想了解 5 个 FILTER-A10 的库存和价格。';
    const fact=(value:string)=>{const start=text.indexOf(value);return {value,evidence:{source:'email' as const,page:0,start,end:start+value.length,quote:value}};};
    const empty={value:'',evidence:{source:'email' as const,page:0,start:0,end:0,quote:''}};
    const graph=workflow(x.erp,x.saver,async()=>({facts:{customer:[],sender:[],location:[],po:[],date:[],address:[]},
      intent:{kind:'inquiry' as const,evidence:fact('想了解')},lines:[{description:fact('FILTER-A10'),quantity:fact('5'),unit:empty}]}));
    await graph.invoke({sources:[{source:'email',page:0,text}]},config('chinese-reply'));
    const s=await graph.getState(config('chinese-reply'));
    assert.match(s.values.inquiry.responseDraft,/您好/);assert.match(s.values.inquiry.responseDraft,/ERP 当前记录库存 12/);
    assert.match(s.values.inquiry.responseDraft,/价格和您要求的交付日期仍需人工确认/);
    assert.doesNotMatch(s.values.inquiry.responseDraft,/Our team/);assert.equal(x.mock.posts,0);
  }finally{await x.close();}
});
test('reply drafting runs after read-only inventory and preserves the requested language',async()=>{
  const x=await setup();try{
    const text='Hei, olen Matti. Kysyisin 10 FILTER-A20 tuotteen saatavuutta ja hintaa.';
    const fact=(value:string)=>{const start=text.indexOf(value);return {value,evidence:{source:'email' as const,page:0,start,end:start+value.length,quote:value}};};
    const empty={value:'',evidence:{source:'email' as const,page:0,start:0,end:0,quote:''}};
    let received:any;
    const graph=workflow(x.erp,x.saver,async()=>({facts:{customer:[],sender:[fact('Matti')],location:[],po:[],date:[],address:[]},
      intent:{kind:'inquiry' as const,evidence:fact('Kysyisin')},reply:{language:'fi'},lines:[{description:fact('FILTER-A20'),quantity:fact('10'),unit:empty}]}),
      async inquiry=>{received=inquiry;return {draft:'Hei Matti,\n\nFILTER-A20-tuotteen ERP-saldo on 0. Hinta ja toimitusaika vahvistetaan erikseen.\n\nYstävällisin terveisin,\nMyyntitiimi',language:'fi',model:'gemini-2.5-flash-lite',traceId:'fictional-reply-trace'};});
    await graph.invoke({sources:[{source:'email',page:0,text}]},config('finnish-reply'));
    const s=await graph.getState(config('finnish-reply'));
    assert.equal(received.lines[0].inventory.totalActualQty,0);assert.equal(received.lines[0].status,'out-of-stock');
    assert.equal(s.values.status,'inquiry-review');assert.equal(s.values.inquiry.replyLanguage,'fi');assert.match(s.values.inquiry.responseDraft,/Hei Matti/);
    assert.equal(s.values.inquiry.replyModel,'gemini-2.5-flash-lite');assert.equal(s.values.inquiry.replyTraceId,'fictional-reply-trace');assert.equal(x.mock.posts,0);
  }finally{await x.close();}
});
test('reply model failure preserves prepared inventory state and never reaches review or ERP write',async()=>{
  const x=await setup();try{
    const text='Hello, is 10 FILTER-A20 available?';
    const fact=(value:string)=>{const start=text.indexOf(value);return {value,evidence:{source:'email' as const,page:0,start,end:start+value.length,quote:value}};};
    const empty={value:'',evidence:{source:'email' as const,page:0,start:0,end:0,quote:''}};
    const graph=workflow(x.erp,x.saver,async()=>({facts:{customer:[],sender:[],location:[],po:[],date:[],address:[]},
      intent:{kind:'inquiry' as const,evidence:fact('available')},reply:{language:'en'},lines:[{description:fact('FILTER-A20'),quantity:fact('10'),unit:empty}]}),
      async()=>{throw Error('GEMINI_HTTP_429');});
    await assert.rejects(graph.invoke({sources:[{source:'email',page:0,text}]},config('reply-failure')),/GEMINI_HTTP_429/);
    const s=await graph.getState(config('reply-failure'));
    assert.equal(s.values.status,'inquiry-prepared');assert.equal(s.values.inquiry.lines[0].inventory.totalActualQty,0);
    assert.equal(s.values.inquiry.responseDraft,'');assert.equal(s.tasks.length,1);assert.equal(s.tasks[0].name,'draftInquiryReply');assert.equal(x.mock.posts,0);
  }finally{await x.close();}
});
test('multi-product English inquiry reports every read-only ERP result and ignores company locale',async()=>{
  const x=await setup();try{
    const text=`TALLINNA KLIIMATEHNIKA OÜ Narva mnt 7, 10117 Tallinn, Estonia\nToomas Tamm, Procurement Manager\nHello,\nWe are looking for a non-binding price quote and availability information. We are interested in these products:\n* 10x Filter A20\n* 12x Radiaatori ventiil H-4\n* 15x Smart Thermostat V1\n* 5x Thermostat X-200\n* 8x Õhufilter Carbon-X\n* 20x Filter\nAre there any expected supply shortages? Please let us know if you can fully deliver the goods. We need the items by October 15, 2026, at the latest.\nThanks in advance for a quick response!\nBest regards,\nToomas Tamm`;
    const fact=(quote:string,value=quote)=>{const start=text.indexOf(quote);const within=quote.indexOf(value);return {value,evidence:{source:'email' as const,page:0,start:start+within,end:start+within+value.length,quote:value}};};
    const line=(description:string,quantityQuote:string,quantity:string)=>({description:fact(description),quantity:fact(quantityQuote,quantity),unit:fact(description,'')});
    const graph=workflow(x.erp,x.saver,async()=>({facts:{customer:[fact('TALLINNA KLIIMATEHNIKA OÜ')],sender:[fact('Toomas Tamm')],location:[fact('Tallinn, Estonia')],po:[],date:[fact('October 15, 2026')],address:[]},
      intent:{kind:'inquiry' as const,evidence:fact('non-binding price quote')},reply:{language:'et'},lines:[
        line('Filter A20','10x','10'),line('Radiaatori ventiil H-4','12x','12'),line('Smart Thermostat V1','15x','15'),
        line('Thermostat X-200','5x','5'),line('Õhufilter Carbon-X','8x','8'),line('Filter','20x','20')]}));
    await graph.invoke({sources:[{source:'email',page:0,text}]},config('multi-inquiry'));
    const s=await graph.getState(config('multi-inquiry'));const inquiry=s.values.inquiry;
    assert.equal(inquiry.replyLanguage,'en');assert.equal(inquiry.lines.length,6);
    assert.deepEqual(inquiry.lines.map((line:any)=>[line.itemCode,line.status,line.inventory?.totalActualQty??null]),[
      ['FILTER-A20','out-of-stock',0],['','unresolved',null],['THERM-S1','recorded-stock',40],
      ['','unresolved',null],['','unresolved',null],['','unresolved',null]
    ]);
    assert.match(inquiry.responseDraft,/Hello Toomas Tamm/);assert.doesNotMatch(inquiry.responseDraft,/Tere/);
    assert.match(inquiry.responseDraft,/FILTER-A20: requested quantity 10; recorded ERP stock is 0/);
    assert.match(inquiry.responseDraft,/THERM-S1: requested quantity 15; recorded ERP stock is 40/);
    assert.match(inquiry.responseDraft,/Thermostat X-200: requested quantity 5; no unique ERP item was found/);
    assert.match(inquiry.responseDraft,/Prices and your requested delivery date still need human confirmation/);
    assert.equal(x.mock.posts,0);
  }finally{await x.close();}
});
test('same PO with changed approved content is never silently reused',async()=>{
  const x=await setup();try {
    await x.graph.invoke({sources:await sources()},config());const s=await x.graph.getState(config());
    await x.erp.createDraft(s.values.draft);
    const changed=structuredClone(s.values.draft);changed.lines[0].quantity='7';
    await assert.rejects(x.erp.createDraft(changed),/DUPLICATE_CHANGED/);assert.equal(x.mock.posts,1);
  }finally{await x.close();}
});
test('human selection resolves an ambiguous model with audit trail',async()=>{
  const x=await setup();try {
    await x.graph.invoke({sources:await sources('02-ambiguous')},config());const s=await x.graph.getState(config());
    const d=structuredClone(s.values.draft);d.lines[0].item='FILTER-A20';
    await x.graph.invoke(new Command({resume:approve(s.values,{draft:d,reason:'Customer confirmed A20 in a follow-up (development test)'})}),config());
    const done=await x.graph.getState(config());assert.equal(done.values.status,'created');assert.equal(done.values.audit[0].draft.lines[0].item,'FILTER-A20');
  }finally{await x.close();}
});

test('permanent duplicate conflict returns to human review instead of a retry trap',async()=>{
  const x=await setup();try {
    await x.graph.invoke({sources:await sources()},config('a'));const a=await x.graph.getState(config('a'));
    await x.erp.createDraft(a.values.draft);
    await x.graph.invoke({sources:await sources()},config('b'));const b=await x.graph.getState(config('b'));
    const changed=structuredClone(b.values.draft);changed.lines[0].quantity='7';
    await x.graph.invoke(new Command({resume:approve(b.values,{draft:changed})}),config('b'));
    const conflict=await x.graph.getState(config('b'));assert.equal(conflict.values.status,'review');
    await x.graph.invoke(new Command({resume:approve(conflict.values,{action:'reject'})}),config('b'));
    assert.equal((await x.graph.getState(config('b'))).values.status,'rejected');assert.equal(x.mock.posts,1);
  }finally{await x.close();}
});
