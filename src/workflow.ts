import { Annotation, StateGraph, START, END, interrupt } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { type ERP } from './erp.js';
import { templateExtractor, verifyEvidence, type Extractor } from './input.js';
import { type Source, type Extraction, type Draft, type Issue, type Customer, type Item, type Address, type Decision, type InquiryCase,
  DecisionSchema, InquiryDecisionSchema, validate, normalize, digest, fields } from './domain.js';

const State = Annotation.Root({
  sources:Annotation<Source[]>(), extracted:Annotation<Extraction>(), draft:Annotation<Draft>(),
  customers:Annotation<Customer[]>(), items:Annotation<Item[]>(), addresses:Annotation<Address[]>(),
  issues:Annotation<Issue[]>(), status:Annotation<string>(), revision:Annotation<string>(),
  decision:Annotation<unknown>(), inquiry:Annotation<InquiryCase>(), order:Annotation<string>(),
  audit:Annotation<unknown[]>({reducer:(a,b)=>a.concat(b),default:()=>[]})
});

function matchingItems(items:Item[],text:string) {
  const exact=items.filter(i=>[i.name,i.item_name].some(v=>normalize(v)===normalize(text)));
  if(exact.length)return exact;
  const modelTokens=[...normalize(text).matchAll(/\b[a-z]+\d+\b/g)].map(match=>match[0]);
  if(!modelTokens.length)return [];
  return items.filter(item=>{
    const candidateTokens=[...normalize(`${item.name} ${item.item_name}`).matchAll(/\b[a-z]+\d+\b/g)].map(match=>match[0]);
    return modelTokens.some(token=>candidateTokens.includes(token));
  });
}

function draftInquiryReply(intent:InquiryCase['intent'],senderName:string,itemCode:string,itemText:string,quantity:string,sourceText:string,modelDraft?:string) {
  if(modelDraft?.trim())return modelDraft.trim();
  const item=itemCode||itemText||'the item you mentioned';
  const amount=quantity?` for a quantity of ${quantity}`:'';
  if(/\p{Script=Han}/u.test(sourceText)) {
    const subject=itemCode||itemText||'您提到的商品';
    const count=quantity?`（数量 ${quantity}）`:'';
    const opening=intent==='conditional'?`感谢您咨询 ${subject}${count}。我们已留意到您需要先确认相关条件再决定是否购买。`
      :intent==='unclear'?`感谢您关于 ${subject}${count} 的来信。我们希望先确认已正确理解您的需求。`
      :`感谢您咨询 ${subject}${count}。`;
    return `您好${senderName?`，${senderName}`:''}：\n\n${opening}\n\n我们正在核对库存、适用价格和预计交期，确认后会尽快回复，方便您决定是否继续。\n\n此致\n销售团队`;
  }
  const opening=intent==='conditional'
    ? `Thanks for checking with us about ${item}${amount}. We understand that the delivery timing matters before you decide.`
    : intent==='unclear'
      ? `Thanks for your message about ${item}${amount}. We want to make sure we have understood your request correctly.`
      : `Thanks for getting in touch about ${item}${amount}.`;
  return `Hello${senderName?` ${senderName}`:''},\n\n${opening}\n\nOur team is confirming availability, the applicable price, and the expected delivery date. We’ll get back to you with those details so you can decide whether to proceed.\n\nBest regards,\nSales team`;
}

export function workflow(erp:ERP, saver:SqliteSaver, extract:Extractor=templateExtractor) {
  async function checkERP(d:Draft) {
    const [customers,items,addresses] = await Promise.all([erp.customers(),erp.items(),d.customer?erp.addresses(d.customer):Promise.resolve([])]);
    const issues = validate(d);
    if(!customers.some(c=>c.name===d.customer)) issues.push({code:'UNKNOWN_CUSTOMER',field:'customer',message:'Select an ERP customer'});
    if(!addresses.some(a=>a.name===d.address)) issues.push({code:'ADDRESS_MISMATCH',field:'address',message:'Choose a linked ERP shipping address'});
    d.lines.forEach((l,i)=>{
      const item=items.find(x=>x.name===l.item);
      if(!item || item.stock_uom!==l.unit) issues.push({code:'ITEM_OR_UNIT',field:`lines.${i}`,message:'Item must exist and unit must equal stock UOM'});
    });
    return issues;
  }
  return new StateGraph(State)
    .addNode('extract',async s=>{
      const extracted=await extract(s.sources); verifyEvidence(extracted,s.sources);
      return {extracted,status:'extracted'};
    })
    .addNode('prepareInquiry',async s=>{
      const [customers,items]=await Promise.all([erp.customers(),erp.items()]);
      const value=(f:typeof fields[number])=>s.extracted.facts[f][0]?.value??'';
      const line=s.extracted.lines[0];
      const customerText=value('customer');
      const senderName=s.extracted.facts.sender[0]?.value??'';
      const customerMatches=customers.filter(c=>[c.name,c.customer_name].some(v=>normalize(v)===normalize(customerText)));
      const itemText=line?.description.value??'';
      const itemMatches=matchingItems(items,itemText);
      const itemCode=itemMatches.length===1?itemMatches[0].name:'';
      const needs:string[]=[];
      if(customerMatches.length!==1) needs.push('确认客户身份或选择 ERP 客户；这不妨碍先回复一般询价');
      if(!itemCode) needs.push('确认准确商品编码');
      let inventory:InquiryCase['inventory']=null;
      if(itemCode) try {
        const stock=await erp.inventory(itemCode);inventory={stockTracked:stock.stockTracked,totalActualQty:stock.totalActualQty};
        if(!stock.stockTracked || stock.totalActualQty===null) needs.push('库存数量未跟踪，需要人工确认');
      } catch {needs.push('库存查询失败，需要人工确认');}
      needs.push('确认适用价格','确认客户要求的交期能否满足');
      const quantity=line?.quantity.value??'';
      const condition=s.extracted.intent?.evidence.value??'';
      const intent=s.extracted.intent?.kind as InquiryCase['intent'];
      const sourceText=s.sources.find(source=>source.source==='email')?.text??s.sources[0]?.text??'';
      const replyLanguage=s.extracted.reply?.language??(/\p{Script=Han}/u.test(sourceText)?'zh':'en');
      const suggested=s.extracted.reply?.draft.replace(/\[(?:your name|name)\]/gi,replyLanguage.startsWith('zh')?'销售团队':'Sales team');
      const responseDraft=draftInquiryReply(intent,senderName,itemCode,itemText,quantity,sourceText,suggested);
      const inquiry:InquiryCase={intent,customerText,senderName,
        customer:customerMatches.length===1?customerMatches[0].name:'',itemText,itemCode,quantity,condition,inventory,needs,replyLanguage,responseDraft};
      return {inquiry,customers,items,issues:[],revision:digest([s.sources,inquiry]),status:'inquiry-review'};
    })
    .addNode('inquiryReview',s=>{
      let feedback='';
      for(;;){
        const parsed=InquiryDecisionSchema.safeParse(interrupt({kind:'inquiry',revision:s.revision,inquiry:s.inquiry,status:s.status,feedback}));
        if(!parsed.success){feedback='INVALID_INQUIRY_DECISION';continue;}
        if(parsed.data.revision!==s.revision){feedback='STALE_APPROVAL';continue;}
        const decision=parsed.data;
        return {decision,inquiry:{...s.inquiry,responseDraft:decision.responseDraft},audit:[decision],
          status:decision.action==='approve-reply'?'response-approved':decision.action==='close'?'closed':'inquiry-review',
          revision:digest([s.revision,decision])};
      }
    })
    .addNode('match',async s=>{
      const [customers,items]=await Promise.all([erp.customers(),erp.items()]);
      const e=s.extracted, issues:Issue[]=[];
      const value=(f:typeof fields[number])=>e.facts[f][0]?.value??'';
      for(const f of fields) if(new Set(e.facts[f].map(x=>normalize(x.value))).size>1) issues.push({code:'SOURCE_CONFLICT',field:f,message:`Email/PDF disagree on ${f}`});
      const matches=customers.filter(c=>normalize(c.customer_name)===normalize(value('customer'))||normalize(c.name)===normalize(value('customer')));
      const customer=matches.length===1?matches[0].name:'';
      const addresses=customer?await erp.addresses(customer):[];
      const addressMatches=addresses.filter(a=>normalize(a.text)===normalize(value('address')));
      const email=e.lines.filter(l=>l.description.evidence.source==='email');
      const pdf=e.lines.filter(l=>l.description.evidence.source==='pdf');
      const signature=(lines:typeof email)=>JSON.stringify(lines.map(l=>[normalize(l.description.value),l.quantity.value,normalize(l.unit.value)]));
      if(email.length && pdf.length && signature(email)!==signature(pdf)) issues.push({code:'LINE_CONFLICT',field:'lines',message:'Email/PDF line descriptions, quantities or units differ; reconcile explicitly'});
      const draft:Draft={customer,po:value('po'),date:value('date'),address:addressMatches.length===1?addressMatches[0].name:'',
        lines:(pdf.length?pdf:email).map(l=>{
          const exact=matchingItems(items,l.description.value);
          return {description:l.description.value,item:exact.length===1?exact[0].name:'',quantity:l.quantity.value,unit:l.unit.value||(exact.length===1?exact[0].stock_uom:'')};
        })};
      issues.push(...await checkERP(draft));
      if(draft.customer && draft.po && (await erp.duplicates(draft)).length) issues.push({code:'DUPLICATE_PO',field:'po',message:'ERP already contains this customer PO; commit will reconcile only an identical integration draft'});
      return {draft,customers,items,addresses,issues,revision:digest([s.sources,draft]),status:'review'};
    })
    .addNode('review',s=>{
      let decision:Decision;
      let feedback='';
      for (;;) {
        const parsed=DecisionSchema.safeParse(interrupt({kind:'order',revision:s.revision,draft:s.draft,issues:s.issues,customers:s.customers,items:s.items,addresses:s.addresses,status:s.status,feedback}));
        if(!parsed.success) {feedback='INVALID_DECISION: check the review JSON shape';continue;}
        if(parsed.data.revision!==s.revision) {feedback='STALE_APPROVAL: export the current review';continue;}
        if(parsed.data.action==='approve' && s.issues.length && !parsed.data.reason.trim()) {feedback='RESOLUTION_REASON_REQUIRED';continue;}
        decision=parsed.data; break;
      }
      return {decision,draft:decision.draft,audit:[decision],status:decision.action==='approve'?'approved':decision.action==='reject'?'rejected':'needs-info',revision:digest([s.revision,decision])};
    })
    .addNode('write',async s=>{
      const issues=await checkERP(s.draft);
      if(issues.length) return {issues,status:'review',revision:digest([s.revision,issues])};
      let order;
      try {order=await erp.createDraft(s.draft);}
      catch(error) {
        if(error instanceof Error && error.message.startsWith('DUPLICATE')) {
          const issues=[{code:'DUPLICATE_PO',field:'po',message:error.message}];
          return {issues,status:'review',revision:digest([s.revision,issues])};
        }
        throw error; // Transport failures remain at this durable node for explicit retry.
      }
      if(order.docstatus!==0) throw Error('ERP_RETURNED_NON_DRAFT');
      return {order:order.name,status:'created',issues:[]};
    })
    .addEdge(START,'extract')
    .addConditionalEdges('extract',s=>s.extracted.intent && s.extracted.intent.kind!=='purchase'?'prepareInquiry':'match',['prepareInquiry','match'])
    .addEdge('prepareInquiry','inquiryReview')
    .addConditionalEdges('inquiryReview',s=>s.status==='inquiry-review'?'inquiryReview':END,['inquiryReview',END])
    .addEdge('match','review')
    .addConditionalEdges('review',s=>s.status==='approved'?'write':s.status==='needs-info'?'review':END,['write','review',END])
    .addConditionalEdges('write',s=>s.status==='created'?END:'review',[END,'review'])
    .compile({checkpointer:saver});
}
