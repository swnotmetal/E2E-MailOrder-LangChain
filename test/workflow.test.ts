import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { Command } from '@langchain/langgraph';
import { joinPdfItems, readSources, templateExtractor, verifyEvidence } from '../src/input.js';
import { workflow } from '../src/workflow.js';
import { FrappeERP } from '../src/erp.js';
import { validate, normalizeDate, normalizeQuantity, type Decision, type InquiryDecision } from '../src/domain.js';
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
test('PDF text joining keeps CJK runs intact without dropping Latin separators',()=>{
  assert.equal(joinPdfItems([{str:'如果这批货物能在'},{str:'下周五之前'},{str:'送达我司。'}]),'如果这批货物能在下周五之前送达我司。');
  assert.equal(joinPdfItems([{str:'Reference:'},{str:'FILTER-B50'},{str:'5'}]),'Reference: FILTER-B50 5');
  assert.equal(joinPdfItems([{str:'型号'},{str:'FILTER-B50'},{str:'数量'},{str:'5'}]),'型号FILTER-B50数量5');
  assert.equal(joinPdfItems([{str:'PO: ABC-1',hasEOL:true},{str:'Item: FILTER-A10'}]),'PO: ABC-1\nItem: FILTER-A10');
});
// The template adapter never asserts an intent, so only an extractor that actually understood
// the mail can reach the automatic proposal path. These two stubs pin both sides of the gate.
const cleanOrderText='Customer: Acme Workshop\nPO: DEMO-777\nDelivery: 2027-03-01\nAddress: 10 Test Road, Helsinki, 00100, Finland\nItem: FILTER-A10 | 5 | Nos';
function orderExtractor(text:string,address:string) {
  const fact=(value:string)=>{const start=text.indexOf(value);return {value,evidence:{source:'email' as const,page:0,start,end:start+value.length,quote:value}};};
  return async()=>({facts:{customer:[fact('Acme Workshop')],sender:[],location:[],po:[fact('DEMO-777')],date:[fact('2027-03-01')],address:[fact(address)]},
    intent:{kind:'purchase' as const,evidence:fact('Item:')},
    lines:[{description:fact('FILTER-A10'),quantity:fact('5'),unit:fact('Nos')}]});
}
test('a conforming purchase is proposed to the ERP without a human interrupt',async()=>{
  const x=await setup();try{
    const graph=workflow(x.erp,x.saver,orderExtractor(cleanOrderText,'10 Test Road, Helsinki, 00100, Finland'));
    await graph.invoke({sources:[{source:'email',page:0,text:cleanOrderText}]},config('auto-propose'));
    const s=await graph.getState(config('auto-propose'));
    assert.equal(s.values.conformance,'');
    assert.equal(s.values.status,'created');
    assert.equal(s.tasks.length,0);
    assert.equal(x.mock.posts,1);
    assert.equal(s.values.audit.length,1);
    assert.equal(s.values.audit[0].action,'auto-propose');
    assert.equal(s.values.audit[0].actor,'assistant');
  }finally{await x.close();}
});
test('natural-language dates are normalised to YYYY-MM-DD; relative dates stay for a human',()=>{
  assert.equal(normalizeDate('March 8, 2027'),'2027-03-08');
  assert.equal(normalizeDate('2027-03-05'),'2027-03-05');
  assert.equal(normalizeDate('next Friday'),'next Friday');
});
test('grouped quantities are ungrouped but locale decimals stay for a human',()=>{
  assert.equal(normalizeQuantity('5,000'),'5000');
  assert.equal(normalizeQuantity('10 000'),'10000');
  assert.equal(normalizeQuantity('1,234,567'),'1234567');
  assert.equal(normalizeQuantity('12'),'12');
  // A decimal comma is ambiguous across locales and must never be silently multiplied by ten.
  assert.equal(normalizeQuantity('1,5'),'1,5');
  assert.equal(normalizeQuantity('0,25'),'0,25');
});
test('a natural-language order normalises its date and unit to pass validation',async()=>{
  const x=await setup();try{
    const text='Customer: Acme Workshop\nPO: DEMO-888\nDelivery: March 8, 2027\nAddress: 10 Test Road, Helsinki, 00100, Finland\nItem: FILTER-A10 | 12 | units';
    const fact=(value:string)=>{const start=text.indexOf(value);return {value,evidence:{source:'email' as const,page:0,start,end:start+value.length,quote:value}};};
    const graph=workflow(x.erp,x.saver,async()=>({facts:{customer:[fact('Acme Workshop')],sender:[],location:[],po:[fact('DEMO-888')],date:[fact('March 8, 2027')],address:[fact('10 Test Road, Helsinki, 00100, Finland')]},
      intent:{kind:'purchase' as const,evidence:fact('Item:')},
      lines:[{description:fact('FILTER-A10'),quantity:fact('12'),unit:fact('units')}]}));
    await graph.invoke({sources:[{source:'email',page:0,text}]},config('normalize'));
    const s=await graph.getState(config('normalize'));
    assert.equal(s.values.draft.date,'2027-03-08');
    assert.equal(s.values.draft.lines[0].unit,'Nos');
    assert.equal(s.values.status,'created');
    assert.equal(x.mock.posts,1);
  }finally{await x.close();}
});
test('a purchase with any unresolved issue still stops behind the human interrupt',async()=>{
  const x=await setup();try{
    const text=cleanOrderText.replace('10 Test Road, Helsinki, 00100, Finland','999 Nowhere Lane, Berlin');
    const graph=workflow(x.erp,x.saver,orderExtractor(text,'999 Nowhere Lane, Berlin'));
    await graph.invoke({sources:[{source:'email',page:0,text}]},config('not-conforming'));
    const s=await graph.getState(config('not-conforming'));
    assert.match(s.values.conformance,/^deterministic validation failed: /);
    assert.match(s.values.conformance,/ADDRESS_MISMATCH/);
    assert.equal(s.values.status,'review');
    assert.equal(s.tasks[0].interrupts.length,1);
    assert.equal(x.mock.posts,0);
    assert.equal(s.values.audit.length,0);
  }finally{await x.close();}
});
const inquiryText='Hello, we would like 5 FILTER-A10 for our workshop.\n\nBest regards,\nMatti';
function inquiryExtractor(text:string,item='FILTER-A10',quantity='5') {
  const fact=(value:string)=>{const start=text.indexOf(value);return {value,evidence:{source:'email' as const,page:0,start,end:start+value.length,quote:value}};};
  const empty={value:'',evidence:{source:'email' as const,page:0,start:0,end:0,quote:''}};
  return async()=>({facts:{customer:[],sender:[fact('Matti')],location:[],po:[],date:[],address:[]},
    intent:{kind:'inquiry' as const,evidence:fact('would like')},
    lines:[{description:fact(item),quantity:fact(quantity),unit:empty}]});
}
test('dash-separated codes like AMBIG-24V resolve uniquely instead of staying unresolved',async()=>{
  const x=await setup();try{
    const text='Item: Fuel Filter Assembly | 20 | Nos\nItem: THERM-P1 Pro | 10 | Nos\nItem: AMBIG-24V Relay | 100 | Nos';
    const fact=(value:string)=>{const start=text.indexOf(value);return {value,evidence:{source:'email' as const,page:0,start,end:start+value.length,quote:value}};};
    const graph=workflow(x.erp,x.saver,async()=>({facts:{customer:[],sender:[],location:[],po:[],date:[],address:[]},
      intent:{kind:'purchase' as const,evidence:fact('Item:')},
      lines:[{description:fact('Fuel Filter Assembly'),quantity:fact('20'),unit:fact('Nos')},
             {description:fact('THERM-P1 Pro'),quantity:fact('10'),unit:fact('Nos')},
             {description:fact('AMBIG-24V Relay'),quantity:fact('100'),unit:fact('Nos')}]}));
    await graph.invoke({sources:[{source:'email',page:0,text}]},config('dash-code'));
    const s=await graph.getState(config('dash-code'));
    assert.deepEqual(s.values.draft.lines.map((line:any)=>line.item),['','THERM-P1','AMBIG-24V']);
  }finally{await x.close();}
});
test('a human-confirmed new customer is created before the order is written',async()=>{
  const x=await setup();try{
    const text='Customer: Kiviniemi Oy\nPO: KV-2027-001\nDelivery: 2027-03-05\nAddress: 10 Katu, Helsinki, 00100, Finland\nItem: FILTER-A10 | 5 | Nos';
    const fact=(value:string)=>{const start=text.indexOf(value);return {value,evidence:{source:'email' as const,page:0,start,end:start+value.length,quote:value}};};
    const graph=workflow(x.erp,x.saver,async()=>({facts:{customer:[fact('Kiviniemi Oy')],sender:[],location:[],po:[fact('KV-2027-001')],date:[fact('2027-03-05')],address:[fact('10 Katu, Helsinki, 00100, Finland')]},
      intent:{kind:'purchase' as const,evidence:fact('Item:')},
      lines:[{description:fact('FILTER-A10'),quantity:fact('5'),unit:fact('Nos')}]}));
    await graph.invoke({sources:[{source:'email',page:0,text}]},config('new-customer'));
    const s=await graph.getState(config('new-customer'));
    // Stops at review: the customer is unknown, and the AI only proposes, never creates.
    assert.equal(s.values.status,'review');
    assert.equal(s.values.newCustomer.name,'Kiviniemi Oy');
    assert.equal(s.values.newCustomer.address,'10 Katu, Helsinki, 00100, Finland');
    assert.equal(x.mock.createdCustomers.length,0);
    const decision={action:'approve',revision:s.values.revision,actor:'test-operator',reason:'New customer confirmed',draft:s.values.draft,newCustomer:{name:'Kiviniemi Oy',address:'10 Katu, Helsinki, 00100, Finland'}};
    await graph.invoke(new Command({resume:decision}),config('new-customer'));
    const done=await graph.getState(config('new-customer'));
    assert.equal(done.values.status,'created');
    assert.equal(done.values.order,'MOCK-SO-1');
    assert.equal(x.mock.createdCustomers.length,1);
    assert.equal(x.mock.createdCustomers[0].name,'Kiviniemi Oy');
    assert.equal(done.values.draft.customer,'Kiviniemi Oy');
  }finally{await x.close();}
});
test('an order that names a catalog-miss item drafts a customer note and files it on approval',async()=>{
  const x=await setup();try{
    const text='Customer: Acme Workshop\nPO: DEMO-900\nDelivery: 2027-03-01\nAddress: 10 Test Road, Helsinki, 00100, Finland\nItem: Flux Capacitor X99 | 3 | Nos';
    const fact=(value:string)=>{const start=text.indexOf(value);return {value,evidence:{source:'email' as const,page:0,start,end:start+value.length,quote:value}};};
    const graph=workflow(x.erp,x.saver,async()=>({facts:{customer:[fact('Acme Workshop')],sender:[],location:[],po:[fact('DEMO-900')],date:[fact('2027-03-01')],address:[fact('10 Test Road, Helsinki, 00100, Finland')]},
      intent:{kind:'purchase' as const,evidence:fact('Item:')},
      lines:[{description:fact('Flux Capacitor X99'),quantity:fact('3'),unit:fact('Nos')}]}));
    await graph.invoke({sources:[{source:'email',page:0,text}]},config('catalog-note'));
    const s=await graph.getState(config('catalog-note'));
    assert.equal(s.values.status,'review');
    assert.match(s.values.customerNote,/Flux Capacitor X99/);
    assert.match(s.values.customerNote,/checking whether this product can be supplied/);
    assert.equal(x.mock.suggestions,0);
    const decision={action:'approve',revision:s.values.revision,actor:'test-operator',reason:'Confirm the item with the customer',draft:s.values.draft,customerNote:s.values.customerNote};
    await graph.invoke(new Command({resume:decision}),config('catalog-note'));
    const done=await graph.getState(config('catalog-note'));
    assert.equal(x.mock.suggestions,1);
    assert.equal(done.values.status,'review'); // the unresolved item still blocks the order write
    assert.match(x.mock.todos[0].description,/Flux Capacitor X99/);
    assert.match(x.mock.todos[0].description,/Suggested reply \(not sent\)/);
  }finally{await x.close();}
});
test('a conforming inquiry is filed as an ERP work item without a human interrupt',async()=>{
  const x=await setup();try{
    const graph=workflow(x.erp,x.saver,inquiryExtractor(inquiryText));
    await graph.invoke({sources:[{source:'email',page:0,text:inquiryText}]},config('auto-inquiry'));
    const s=await graph.getState(config('auto-inquiry'));
    assert.equal(s.values.conformance,'');
    assert.equal(s.values.status,'suggested');
    assert.equal(s.tasks.length,0);
    assert.equal(x.mock.posts,0);
    assert.equal(x.mock.suggestions,1);assert.equal(s.values.suggestion,'MOCK-TODO-1');
    assert.equal(s.values.audit.length,1);
    assert.equal(s.values.audit[0].action,'suggest-reply');
    assert.equal(s.values.audit[0].actor,'assistant');
    const todo=x.mock.todos[0];
    assert.equal(todo.status,'Open');
    // No single ERP customer was matched, so the work item carries no link rather than a guess.
    assert.equal(todo.reference_name,undefined);
    assert.match(todo.description,/^Inquiry from Matti \(not matched to an ERP customer\) — inquiry/);
    // The human sees the exact suggested text in the ERP, not a summary of it.
    assert.ok(todo.description.includes(s.values.inquiry.responseDraft));
    // Re-ingesting the same mail reconciles to that work item instead of filing a second one, and
    // the identity is the message rather than the model prose: a reworded reply still reconciles.
    const reworded=workflow(x.erp,x.saver,inquiryExtractor(inquiryText),async()=>({draft:'Reworded reply for the same message.',language:'en'}));
    await reworded.invoke({sources:[{source:'email',page:0,text:inquiryText}]},config('auto-inquiry-again'));
    const again=await reworded.getState(config('auto-inquiry-again'));
    assert.equal(x.mock.suggestions,1);assert.equal(again.values.suggestion,'MOCK-TODO-1');
  }finally{await x.close();}
});
test('only an automatic proposal notifies, and a dead notice channel never unwinds the ERP write',async()=>{
  const x=await setup();try{
    const notices:any[]=[];let fail=false;
    const notifier=async(notice:any)=>{if(fail) throw Error('SMTP_DOWN');notices.push(notice);};
    const graph=workflow(x.erp,x.saver,inquiryExtractor(inquiryText),undefined,notifier);
    await graph.invoke({sources:[{source:'email',page:0,text:inquiryText}]},config('notify-ok'));
    const s=await graph.getState(config('notify-ok'));
    assert.equal(s.values.status,'suggested');assert.equal(x.mock.suggestions,1);
    assert.equal(notices.length,1);assert.equal(notices[0].kind,'reply-suggestion');
    assert.equal(notices[0].reference,s.values.suggestion);assert.equal(notices[0].customer,'');
    assert.equal(s.values.audit.length,1);
    // A run that stops at the interrupt filed no proposal, so it notifies nobody.
    const unclear=workflow(x.erp,x.saver,async()=>({facts:{customer:[],sender:[],location:[],po:[],date:[],address:[]},lines:[],reply:{language:'en'},
      warnings:[{code:'UNRESOLVED_MODEL_EVIDENCE',field:'intent',message:'Confirm intent from the original message'}]}),undefined,notifier);
    await unclear.invoke({sources:[{source:'email',page:0,text:'A fictional unclear email.'}]},config('notify-interrupt'));
    assert.equal(notices.length,1);assert.equal(x.mock.suggestions,1);
    // A dead notification channel must not fail the run or hide the work item already filed.
    fail=true;
    const secondText='Hello, we would like 3 FILTER-A20.\n\nBest regards,\nMatti';
    const second=workflow(x.erp,x.saver,inquiryExtractor(secondText,'FILTER-A20','3'),undefined,notifier);
    await second.invoke({sources:[{source:'email',page:0,text:secondText}]},config('notify-failed'));
    const f=await second.getState(config('notify-failed'));
    assert.equal(f.values.status,'suggested');assert.equal(x.mock.suggestions,2);assert.equal(notices.length,1);
    assert.equal(f.values.audit.length,2);assert.equal(f.values.audit[1].action,'notify-failed');
  }finally{await x.close();}
});
test('clean order interrupts before HTTP write then creates a draft',async()=>{
  const x=await setup();try {
    await x.graph.invoke({sources:await sources()},config());
    let s=await x.graph.getState(config());assert.equal(x.mock.posts,0);assert.equal(s.tasks[0].interrupts.length,1);assert.deepEqual(s.values.issues,[]);
    assert.deepEqual(s.values.availability.map((line:any)=>[line.itemCode,line.status,line.inventory?.totalActualQty]),[['FILTER-A10','recorded-stock',12]]);
    await x.graph.invoke(new Command({resume:approve(s.values)}),config());
    s=await x.graph.getState(config());assert.equal(s.values.status,'created');assert.equal(x.mock.orders[0].docstatus,0);
  }finally{await x.close();}
});
test('ambiguous description stays unresolved and approval loops back',async()=>{
  const x=await setup();try {
    await x.graph.invoke({sources:await sources('02-ambiguous')},config());const s=await x.graph.getState(config());
    assert.equal(s.values.draft.lines[0].item,'');assert.equal(s.values.availability[0].status,'unresolved');
    assert.ok(s.values.items.some((i:any)=>i.name==='FILTER-A10'));assert.ok(s.values.items.some((i:any)=>i.name==='FILTER-A20'));
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
test('catalog queries have bounded terms and reject oversized descriptions',async t=>{
  const erp=new FrappeERP('http://127.0.0.1:3211','token test:test','Nordic Parts Demo');
  let requestedUrl='';
  t.mock.method(globalThis,'fetch',async(url:unknown)=>{
    requestedUrl=String(url);
    return Response.json({data:[]});
  });
  const query=Array.from({length:30},(_,index)=>`term${index}`).join(' ');
  await erp.findItems(query);
  const orFilters=JSON.parse(new URL(requestedUrl).searchParams.get('or_filters')??'[]');
  assert.equal(orFilters.length,16);
  assert.throws(()=>erp.findItems('x'.repeat(501)),/CATALOG_QUERY_LIMIT/);
});
test('inquiry and conditional intents skip order validation; unclear intent keeps the human interrupt',async()=>{
  for(const kind of ['inquiry','conditional','unclear'] as const){
    const x=await setup();try{
      const graph=workflow(x.erp,x.saver,async input=>{const e=await templateExtractor(input);return {...e,intent:{kind,evidence:e.facts.po[0]}};});
      await graph.invoke({sources:await sources()},config());
      const s=await graph.getState(config());
      assert.deepEqual(s.values.issues,[]);
      assert.equal(s.values.inquiry.lines[0].itemCode,'FILTER-A10');assert.equal(s.values.inquiry.lines[0].inventory.totalActualQty,12);
      if(kind!=='unclear') {
        assert.match(s.values.inquiry.responseDraft,/checking whether the requested quantity of 5 can be allocated/);
        assert.match(s.values.inquiry.responseDraft,/consolidated quotation will include pricing/);
        assert.doesNotMatch(s.values.inquiry.responseDraft,/ERP|stock is 12/);
        assert.doesNotMatch(s.values.inquiry.responseDraft,/No order has been created/);
      }
      assert.equal(x.mock.posts,0);
      if(kind==='unclear') {
        // An unclear intent generates no reply: it stops at the interrupt with an empty draft, and
        // approving an empty draft is refused rather than filing a nonsense work item.
        assert.equal(s.values.status,'inquiry-review');
        assert.equal(s.values.conformance,'the intent is not a determinate inquiry');
        assert.equal(s.values.inquiry.responseDraft,'');
        assert.equal((s.tasks[0].interrupts[0].value as any).kind,'inquiry');
        assert.equal(x.mock.suggestions,0);
        const empty:InquiryDecision={action:'approve-reply',revision:s.values.revision,actor:'test-operator',reason:'tried to approve an empty reply',responseDraft:''};
        await graph.invoke(new Command({resume:empty}),config());
        const refused=await graph.getState(config());
        assert.equal(refused.values.status,'inquiry-review');assert.equal(x.mock.suggestions,0);
        assert.match((refused.tasks[0].interrupts[0].value as any).feedback,/REPLY_DRAFT_EMPTY/);
        const closed:InquiryDecision={action:'close',revision:refused.values.revision,actor:'test-operator',reason:'Not a customer request',responseDraft:''};
        await graph.invoke(new Command({resume:closed}),config());
        assert.equal((await graph.getState(config())).values.status,'closed');assert.equal(x.mock.suggestions,0);
      } else {
        assert.equal(s.values.conformance,'');assert.equal(s.values.status,'suggested');assert.equal(s.tasks.length,0);
        assert.equal(x.mock.suggestions,1);assert.equal(x.mock.todos[0].reference_name,s.values.inquiry.customer);
      }
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
    assert.equal(s.values.inquiry.lines[0].itemCode,'FILTER-A10');assert.equal(s.values.status,'suggested');assert.equal(x.mock.posts,0);
    assert.equal(x.mock.suggestions,1);
  }finally{await x.close();}
});
test('fuzzy catalog candidates are ranked for review but never auto-selected',async()=>{
  const x=await setup();try{
    const text='We need 5 Smart Thermostat units.';
    const fact=(value:string)=>{const start=text.indexOf(value);return {value,evidence:{source:'email' as const,page:0,start,end:start+value.length,quote:value}};};
    const empty={value:'',evidence:{source:'email' as const,page:0,start:0,end:0,quote:''}};
    const graph=workflow(x.erp,x.saver,async()=>({facts:{customer:[],sender:[],location:[],po:[],date:[],address:[]},
      intent:{kind:'purchase' as const,evidence:fact('need')},lines:[{description:fact('Smart Thermostat'),quantity:fact('5'),unit:empty}]}));
    await graph.invoke({sources:[{source:'email',page:0,text}]},config('fuzzy-catalog'));
    const state=await graph.getState(config('fuzzy-catalog'));
    assert.deepEqual(state.values.items.slice(0,3).map((item:any)=>[item.name,item.score,item.matchedTerms]),[
      ['THERM-S1',2,['smart','thermostat']],['THERM-B1',1,['thermostat']],['THERM-P1',1,['thermostat']]
    ]);
    assert.equal(state.values.draft.lines[0].item,'');
    assert.equal(state.values.availability[0].status,'unresolved');
    assert.equal(x.mock.posts,0);
  }finally{await x.close();}
});
test('reply language follows the prose, not the company country, address or foreign sign-off',async()=>{
  const x=await setup();try{
    const text=`Müller Auto Service Garage\nSchumannstraße 45, 10117 Berlin, Germany\nLucas Weber, Einkauf\n\nHello,\nWe are looking to finalize this purchase provided that delivery can be guaranteed by next Friday. Please confirm availability of 5x Filter X200.\n\nMit freundlichen Grüßen\nLucas Weber`;
    const fact=(quote:string,value=quote)=>{const start=text.indexOf(quote);const within=quote.indexOf(value);return {value,evidence:{source:'email' as const,page:0,start:start+within,end:start+within+value.length,quote:value}};};
    const empty={value:'',evidence:{source:'email' as const,page:0,start:0,end:0,quote:''}};
    const graph=workflow(x.erp,x.saver,async()=>({facts:{customer:[fact('Müller Auto Service Garage')],sender:[fact('Lucas Weber')],location:[],po:[],date:[fact('next Friday')],address:[fact('Schumannstraße 45, 10117 Berlin, Germany')]},
      intent:{kind:'conditional' as const,evidence:fact('provided that delivery can be guaranteed')},reply:{language:'de'},
      lines:[{description:fact('Filter X200'),quantity:fact('5x','5'),unit:empty}]}));
    await graph.invoke({sources:[{source:'email',page:0,text}]},config('locale-mismatch'));
    const inquiry=(await graph.getState(config('locale-mismatch'))).values.inquiry;
    assert.equal(inquiry.replyLanguage,'en');
    assert.match(inquiry.responseDraft,/Hello Lucas Weber/);
    assert.match(inquiry.responseDraft,/next Friday is feasible/);
    assert.match(inquiry.responseDraft,/Filter X200: our team is checking whether this product can be supplied/);
    assert.doesNotMatch(inquiry.responseDraft,/Schumannstraße/);
    assert.equal(x.mock.posts,0);
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
    assert.match(s.values.inquiry.responseDraft,/您好/);assert.match(s.values.inquiry.responseDraft,/正在核实是否可从当前库存安排您需要的 5 件/);
    assert.match(s.values.inquiry.responseDraft,/正式报价中一并提供价格/);assert.doesNotMatch(s.values.inquiry.responseDraft,/库存 12|ERP/);
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
    assert.equal(s.values.status,'suggested');assert.equal(s.values.inquiry.replyLanguage,'fi');assert.match(s.values.inquiry.responseDraft,/Hei Matti/);
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
      ['FILTER-A20','out-of-stock',0],['','catalog-miss',null],['THERM-S1','recorded-stock',40],
      ['','catalog-miss',null],['','catalog-miss',null],['','unresolved',null]
    ]);
    assert.match(inquiry.responseDraft,/Hello Toomas Tamm/);assert.doesNotMatch(inquiry.responseDraft,/Tere/);
    assert.match(inquiry.responseDraft,/FILTER-A20: we cannot currently confirm the requested quantity of 10/);
    assert.match(inquiry.responseDraft,/THERM-S1: we are checking whether the requested quantity of 15 can be allocated/);
    assert.match(inquiry.responseDraft,/Thermostat X-200: our team is checking whether this product can be supplied/);
    assert.match(inquiry.responseDraft,/consolidated quotation will include pricing/);
    assert.doesNotMatch(inquiry.responseDraft,/recorded ERP stock|stock is 0|stock is 40|exact item code/);
    assert.equal(x.mock.posts,0);
  }finally{await x.close();}
});
test('inquiry keeps only narrowed catalog candidates out of traced graph state',async()=>{
  const x=await setup();try{
    const text='Hello, Apex Logistics Solutions needs 35 2026 Paragon GT Commercial Motorcycles.';
    const fact=(value:string)=>{const start=text.indexOf(value);return {value,evidence:{source:'email' as const,page:0,start,end:start+value.length,quote:value}};};
    const empty={value:'',evidence:{source:'email' as const,page:0,start:0,end:0,quote:''}};
    const graph=workflow(x.erp,x.saver,async()=>({facts:{customer:[fact('Apex Logistics Solutions')],sender:[],location:[],po:[],date:[],address:[]},
      intent:{kind:'inquiry' as const,evidence:fact('needs')},reply:{language:'en'},lines:[{description:fact('2026 Paragon GT Commercial Motorcycles'),quantity:fact('35'),unit:empty}]}));
    await graph.invoke({sources:[{source:'email',page:0,text}]},config('narrow-state'));
    const values=(await graph.getState(config('narrow-state'))).values;
    assert.deepEqual(values.items,[]);assert.equal('customers' in values,false);
    assert.equal(values.inquiry.lines[0].status,'catalog-miss');
    assert.match(values.inquiry.responseDraft,/our team is checking whether this product can be supplied/);
    assert.doesNotMatch(values.inquiry.responseDraft,/vehicle make|part number/);
  }finally{await x.close();}
});
test('missing grounded intent goes to human inquiry review, never the order path',async()=>{
  const x=await setup();try{
    const text='A fictional customer sent an unclear free-form email.';
    const graph=workflow(x.erp,x.saver,async()=>({facts:{customer:[],sender:[],location:[],po:[],date:[],address:[]},lines:[],reply:{language:'en'},
      warnings:[{code:'UNRESOLVED_MODEL_EVIDENCE',field:'intent',message:'Confirm intent from the original message'}]}));
    await graph.invoke({sources:[{source:'email',page:0,text}]},config('unresolved-intent'));
    const values=(await graph.getState(config('unresolved-intent'))).values;
    assert.equal(values.status,'inquiry-review');assert.equal(values.inquiry.intent,'unclear');assert.equal(x.mock.posts,0);
    assert.equal(values.inquiry.responseDraft,'');
    assert.ok(values.inquiry.needs.some((need:string)=>need.includes('not a clear purchase or inquiry')));
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
