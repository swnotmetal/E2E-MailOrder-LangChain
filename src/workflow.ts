import { Annotation, StateGraph, START, END, interrupt } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { type ERP } from './erp.js';
import { inventoryTool } from './model.js';
import { templateExtractor, verifyEvidence, type Extractor } from './input.js';
import { type Source, type Extraction, type Draft, type Issue, type Customer, type Item, type Address, type Decision, type InquiryCase, type InquiryLine,
  DecisionSchema, InquiryDecisionSchema, validate, normalize, digest, fields } from './domain.js';

const State = Annotation.Root({
  sources:Annotation<Source[]>(), extracted:Annotation<Extraction>(), draft:Annotation<Draft>(),
  customers:Annotation<Customer[]>(), items:Annotation<Item[]>(), addresses:Annotation<Address[]>(),
  availability:Annotation<InquiryLine[]>(),
  issues:Annotation<Issue[]>(), status:Annotation<string>(), revision:Annotation<string>(),
  decision:Annotation<unknown>(), inquiry:Annotation<InquiryCase>(), order:Annotation<string>(),
  audit:Annotation<unknown[]>({reducer:(a,b)=>a.concat(b),default:()=>[]})
});

export type InquiryReplyDrafter=(inquiry:InquiryCase)=>Promise<{draft:string;language?:string;traceId?:string;model?:string}>;

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

function replyLanguage(sourceText:string,modelLanguage?:string) {
  if(/\p{Script=Han}/u.test(sourceText)) return 'zh';
  const text=` ${normalize(sourceText)} `;
  const markers={
    en:[' we ',' are ',' please ',' hello ',' thanks ',' best regards ',' interested ',' need '],
    de:[' wir ',' bitte ',' vielen dank ',' mit freundlichen grüßen ',' lieferung ',' interessiert ',' benötigen '],
    et:[' soovime ',' palun ',' tänud ',' lugupidamisega ',' oleme ',' vajame ',' kaupade ',' kättesaadavuse ']
  } as const;
  const ranked=Object.entries(markers).map(([language,words])=>({language,score:words.filter(word=>text.includes(word)).length})).sort((a,b)=>b.score-a.score);
  if(ranked[0].score>=2 && ranked[0].score>ranked[1].score) return ranked[0].language;
  return modelLanguage?.trim().toLowerCase()||'en';
}

function inventoryText(line:InquiryLine,language:string) {
  const item=line.itemCode||line.itemText||'—';
  const qty=line.quantity||'?';
  const recorded=line.inventory?.totalActualQty;
  const covers=recorded!==null&&recorded!==undefined&&Number.isFinite(Number(qty))&&recorded>=Number(qty);
  if(language==='zh') {
    if(line.status==='recorded-stock'&&covers) return `${item}：我们正在核实是否可从当前库存安排您需要的 ${qty} 件。`;
    if(line.status==='recorded-stock'||line.status==='out-of-stock') return `${item}：目前无法确认您需要的 ${qty} 件，我们正在核实补货及替代方案。`;
    if(line.status==='untracked') return `${item}：您需要 ${qty} 件，库存情况正在人工核实。`;
    if(line.status==='catalog-miss') return `${item}：我们的团队正在核实该商品是否可以供应。`;
    if(line.status==='lookup-failed') return `${item}：询问数量 ${qty}；库存查询失败，需要人工确认。`;
    return `${item}：您需要 ${qty} 件；请提供该商品的型号、规格、制造商参考号或其他识别信息，以便我们确认准确商品。`;
  }
  if(language==='de') {
    if(line.status==='recorded-stock'&&covers) return `${item}: Wir prüfen, ob die angefragten ${qty} Stück aus dem aktuellen Bestand zugeteilt werden können.`;
    if(line.status==='recorded-stock'||line.status==='out-of-stock') return `${item}: Die angefragten ${qty} Stück können wir derzeit nicht bestätigen; wir prüfen Nachschub und Alternativen.`;
    if(line.status==='untracked') return `${item}: Die Verfügbarkeit der angefragten ${qty} Stück wird manuell geprüft.`;
    if(line.status==='catalog-miss') return `${item}: Unser Team prüft derzeit, ob dieser Artikel lieferbar ist.`;
    if(line.status==='lookup-failed') return `${item}: angefragte Menge ${qty}; die Bestandsabfrage ist fehlgeschlagen und muss geprüft werden.`;
    return `${item}: Bitte teilen Sie uns Modell, Variante, Spezifikation, Herstellerreferenz oder andere Identifikationsmerkmale mit, damit wir den genauen Artikel bestätigen können.`;
  }
  if(language==='et') {
    if(line.status==='recorded-stock'&&covers) return `${item}: kontrollime, kas soovitud ${qty} tk saab praegusest laost eraldada.`;
    if(line.status==='recorded-stock'||line.status==='out-of-stock') return `${item}: soovitud ${qty} tk ei saa praegu kinnitada; kontrollime juurdevedu ja alternatiive.`;
    if(line.status==='untracked') return `${item}: soovitud ${qty} tk saadavust kontrollitakse käsitsi.`;
    if(line.status==='catalog-miss') return `${item}: meie meeskond kontrollib, kas seda toodet on võimalik tarnida.`;
    if(line.status==='lookup-failed') return `${item}: küsitud kogus ${qty}; laopäring ebaõnnestus ja vajab käsitsi kontrolli.`;
    return `${item}: palun saatke mudel, variant, spetsifikatsioon, tootja viide või muud tunnused, et saaksime täpse toote kinnitada.`;
  }
  if(line.status==='recorded-stock'&&covers) return `${item}: we are checking whether the requested quantity of ${qty} can be allocated from current stock.`;
  if(line.status==='recorded-stock'||line.status==='out-of-stock') return `${item}: we cannot currently confirm the requested quantity of ${qty}; we are checking replenishment and alternatives.`;
  if(line.status==='untracked') return `${item}: availability for the requested quantity of ${qty} is being checked manually.`;
  if(line.status==='catalog-miss') return `${item}: our team is checking whether this product can be supplied.`;
  if(line.status==='lookup-failed') return `${item}: requested quantity ${qty}; the inventory lookup failed and needs manual confirmation.`;
  return `${item}: for the requested quantity of ${qty}, please share the model, variant, specification, manufacturer reference or any other identifying details so we can confirm the exact product.`;
}

function draftInquiryReply(senderName:string,lines:InquiryLine[],language:string,requestedDate:string,deliveryAddress:string) {
  const details=lines.map(line=>`- ${inventoryText(line,language)}`).join('\n');
  if(language==='zh') return `您好${senderName?`，${senderName}`:''}：\n\n感谢您的询价。以下是我们目前正在核实的情况：\n\n${details}\n\n我们会在正式报价中一并提供价格，并确认${[requestedDate,deliveryAddress].filter(Boolean).join('，')||'您要求的交付安排'}是否可行。在正式确认前，库存尚未预留。\n\n此致\n销售团队`;
  if(language==='de') return `Guten Tag${senderName?` ${senderName}`:''},\n\nvielen Dank für Ihre Anfrage. Wir prüfen derzeit Folgendes:\n\n${details}\n\nUnser zusammengefasstes Angebot enthält die Preise und bestätigt, ob ${[requestedDate,deliveryAddress].filter(Boolean).join(' / ')||'die gewünschte Lieferung'} möglich ist. Bis zur Bestätigung ist keine Ware reserviert.\n\nMit freundlichen Grüßen\nVertriebsteam`;
  if(language==='et') return `Tere${senderName?` ${senderName}`:''},\n\ntäname päringu eest. Kontrollime praegu järgmist:\n\n${details}\n\nKoondpakkumises esitame hinnad ja kinnitame, kas ${[requestedDate,deliveryAddress].filter(Boolean).join(' / ')||'soovitud tarne'} on võimalik. Kuni kinnitamiseni ei ole kaup broneeritud.\n\nLugupidamisega\nMüügimeeskond`;
  return `Hello${senderName?` ${senderName}`:''},\n\nThank you for your inquiry. We are currently checking the following:\n\n${details}\n\nOur consolidated quotation will include pricing and confirm whether ${[requestedDate,deliveryAddress].filter(Boolean).join(' to ')||'the requested delivery'} is feasible. No stock is reserved until we confirm it.\n\nBest regards,\nSales team`;
}

const templateReplyDrafter:InquiryReplyDrafter=async inquiry=>({
  draft:draftInquiryReply(inquiry.senderName,inquiry.lines,inquiry.replyLanguage,inquiry.requestedDate,inquiry.deliveryAddress),language:inquiry.replyLanguage
});

export function workflow(erp:ERP, saver:SqliteSaver, extract:Extractor=templateExtractor, draftReply:InquiryReplyDrafter=templateReplyDrafter) {
  const inventoryReader=inventoryTool(erp);
  async function resolveAvailability(extracted:Extraction) {
    const email=extracted.lines.filter(line=>line.description.evidence.source==='email');
    const pdf=extracted.lines.filter(line=>line.description.evidence.source==='pdf');
    const selected=extracted.intent?.kind==='purchase'?(pdf.length?pdf:email):(email.length?email:extracted.lines);
    const candidates=await Promise.all(selected.map(line=>erp.findItems(line.description.value)));
    const items=[...new Map(candidates.flat().map(item=>[item.name,item])).values()];
    const availability=await Promise.all(selected.map(async (line,index)=>{
      const itemText=line.description.value;
      const itemMatches=matchingItems(candidates[index],itemText);
      const itemCode=itemMatches.length===1?itemMatches[0].name:'';
      const base={itemText,itemCode,quantity:line.quantity.value};
      if(!itemCode) return {...base,status:candidates[index].length?'unresolved':'catalog-miss',inventory:null} as InquiryLine;
      try {
        const stock=await inventoryReader.invoke({itemCode});
        const inventory={stockTracked:stock.stockTracked,totalActualQty:stock.totalActualQty};
        const status=!stock.stockTracked||stock.totalActualQty===null?'untracked':stock.totalActualQty===0?'out-of-stock':'recorded-stock';
        return {...base,status,inventory} as InquiryLine;
      } catch {return {...base,status:'lookup-failed',inventory:null} as InquiryLine;}
    }));
    return {items,availability};
  }
  async function checkERP(d:Draft) {
    const [customers,itemMatches,addresses] = await Promise.all([erp.findCustomers(d.customer),Promise.all(d.lines.map(l=>erp.findItems(l.item))),d.customer?erp.addresses(d.customer):Promise.resolve([])]);
    const issues = validate(d);
    if(!customers.some(c=>c.name===d.customer)) issues.push({code:'UNKNOWN_CUSTOMER',field:'customer',message:'Select an ERP customer'});
    if(!addresses.some(a=>a.name===d.address)) issues.push({code:'ADDRESS_MISMATCH',field:'address',message:'Choose a linked ERP shipping address'});
    d.lines.forEach((l,i)=>{
      const item=itemMatches[i].find(x=>x.name===l.item);
      if(!item || item.stock_uom!==l.unit) issues.push({code:'ITEM_OR_UNIT',field:`lines.${i}`,message:'Item must exist and unit must equal stock UOM'});
    });
    return issues;
  }
  return new StateGraph(State)
    .addNode('extract',async s=>{
      const extracted=await extract(s.sources); verifyEvidence(extracted,s.sources);
      return {extracted,status:'extracted'};
    })
    .addNode('resolveInventory',async s=>({...await resolveAvailability(s.extracted),status:'inventory-checked'}))
    .addNode('prepareInquiry',async s=>{
      const value=(f:typeof fields[number])=>s.extracted.facts[f][0]?.value??'';
      const customerText=value('customer');
      const senderName=s.extracted.facts.sender[0]?.value??'';
      const customers=await erp.findCustomers(customerText);
      const customerMatches=customers.filter(c=>[c.name,c.customer_name].some(v=>normalize(v)===normalize(customerText)));
      const needs:string[]=(s.extracted.warnings??[]).map(w=>`${w.field} 的模型证据不可靠，请对照原邮件确认`);
      if(customerMatches.length!==1) needs.push('确认客户身份或选择 ERP 客户；这不妨碍先回复一般询价');
      const lines=s.availability;
      if(lines.some(line=>line.status==='unresolved')) needs.push('确认未能唯一匹配的准确商品编码');
      if(lines.some(line=>line.status==='catalog-miss')) needs.push('ERP 目录没有候选商品，由人工确认是否供应；不要要求客户解决内部目录问题');
      if(lines.some(line=>line.status==='untracked')) needs.push('库存数量未跟踪，需要人工确认');
      if(lines.some(line=>line.status==='lookup-failed')) needs.push('库存查询失败，需要人工确认');
      needs.push('确认适用价格','确认客户要求的交期能否满足');
      const condition=s.extracted.intent?.evidence.value??'';
      const kind=s.extracted.intent?.kind;
      const intent:InquiryCase['intent']=kind==='inquiry'||kind==='conditional'||kind==='unclear'?kind:'unclear';
      const sourceText=s.sources.find(source=>source.source==='email')?.text??s.sources[0]?.text??'';
      const language=replyLanguage(sourceText,s.extracted.reply?.language);
      const inquiry:InquiryCase={intent,customerText,senderName,
        customer:customerMatches.length===1?customerMatches[0].name:'',lines,condition,requestedDate:value('date'),deliveryAddress:value('address'),needs,replyLanguage:language,responseDraft:''};
      return {inquiry,issues:[],status:'inquiry-prepared'};
    })
    .addNode('draftInquiryReply',async s=>{
      const reply=await draftReply(s.inquiry);
      if(!reply.draft.trim()) throw Error('MODEL_REPLY_EMPTY');
      const inquiry:InquiryCase={...s.inquiry,responseDraft:reply.draft.trim(),replyLanguage:reply.language??s.inquiry.replyLanguage,
        replyTraceId:reply.traceId,replyModel:reply.model};
      return {inquiry,revision:digest([s.sources,inquiry]),status:'inquiry-review'};
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
      const e=s.extracted, issues:Issue[]=[...(s.extracted.warnings??[])];
      const value=(f:typeof fields[number])=>e.facts[f][0]?.value??'';
      const customers=await erp.findCustomers(value('customer')),items=s.items;
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
    .addEdge('extract','resolveInventory')
    .addConditionalEdges('resolveInventory',s=>s.extracted.intent?.kind==='purchase'||(!s.extracted.intent&&!s.extracted.warnings?.some(w=>w.field==='intent'))?'match':'prepareInquiry',['prepareInquiry','match'])
    .addEdge('prepareInquiry','draftInquiryReply')
    .addEdge('draftInquiryReply','inquiryReview')
    .addConditionalEdges('inquiryReview',s=>s.status==='inquiry-review'?'inquiryReview':END,['inquiryReview',END])
    .addEdge('match','review')
    .addConditionalEdges('review',s=>s.status==='approved'?'write':s.status==='needs-info'?'review':END,['write','review',END])
    .addConditionalEdges('write',s=>s.status==='created'?END:'review',[END,'review'])
    .compile({checkpointer:saver});
}
