import { Annotation, StateGraph, START, END, interrupt } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { type ERP } from './erp.js';
import { templateExtractor, verifyEvidence, type Extractor } from './input.js';
import { type Source, type Extraction, type Draft, type Issue, type Customer, type Item, type Address, type Decision, type InquiryCase, type InquiryLine,
  DecisionSchema, InquiryDecisionSchema, validate, normalize, digest, fields } from './domain.js';

const State = Annotation.Root({
  sources:Annotation<Source[]>(), extracted:Annotation<Extraction>(), draft:Annotation<Draft>(),
  customers:Annotation<Customer[]>(), items:Annotation<Item[]>(), addresses:Annotation<Address[]>(),
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
  if(language==='zh') {
    if(line.status==='recorded-stock') return `${item}：询问数量 ${qty}；ERP 当前记录库存 ${line.inventory?.totalActualQty}（这不是预留或交付承诺）。`;
    if(line.status==='out-of-stock') return `${item}：询问数量 ${qty}；ERP 当前记录库存为 0，暂不能确认供货。`;
    if(line.status==='untracked') return `${item}：询问数量 ${qty}；ERP 不跟踪该商品库存数量，需要人工确认。`;
    if(line.status==='lookup-failed') return `${item}：询问数量 ${qty}；库存查询失败，需要人工确认。`;
    return `${item}：询问数量 ${qty}；无法唯一匹配 ERP 商品，请确认准确商品编码。`;
  }
  if(language==='de') {
    if(line.status==='recorded-stock') return `${item}: angefragte Menge ${qty}; im ERP erfasster Bestand ${line.inventory?.totalActualQty} (keine Reservierungs- oder Lieferzusage).`;
    if(line.status==='out-of-stock') return `${item}: angefragte Menge ${qty}; erfasster ERP-Bestand 0, daher können wir die Verfügbarkeit derzeit nicht bestätigen.`;
    if(line.status==='untracked') return `${item}: angefragte Menge ${qty}; die Bestandsmenge wird im ERP nicht geführt und muss geprüft werden.`;
    if(line.status==='lookup-failed') return `${item}: angefragte Menge ${qty}; die Bestandsabfrage ist fehlgeschlagen und muss geprüft werden.`;
    return `${item}: angefragte Menge ${qty}; kein eindeutiger ERP-Artikel gefunden. Bitte bestätigen Sie die genaue Artikelnummer.`;
  }
  if(language==='et') {
    if(line.status==='recorded-stock') return `${item}: küsitud kogus ${qty}; ERP-s registreeritud laoseis ${line.inventory?.totalActualQty} (see ei ole broneering ega tarnelubadus).`;
    if(line.status==='out-of-stock') return `${item}: küsitud kogus ${qty}; ERP-s registreeritud laoseis on 0, seega ei saa saadavust praegu kinnitada.`;
    if(line.status==='untracked') return `${item}: küsitud kogus ${qty}; ERP ei jälgi selle toote laokogust ja see vajab käsitsi kontrolli.`;
    if(line.status==='lookup-failed') return `${item}: küsitud kogus ${qty}; laopäring ebaõnnestus ja vajab käsitsi kontrolli.`;
    return `${item}: küsitud kogus ${qty}; ühest ERP toodet ei leitud. Palun kinnitage täpne tootekood.`;
  }
  if(line.status==='recorded-stock') return `${item}: requested quantity ${qty}; recorded ERP stock is ${line.inventory?.totalActualQty} (not a reservation or delivery commitment).`;
  if(line.status==='out-of-stock') return `${item}: requested quantity ${qty}; recorded ERP stock is 0, so availability cannot currently be confirmed.`;
  if(line.status==='untracked') return `${item}: requested quantity ${qty}; ERP does not track a stock quantity for this item, so manual confirmation is needed.`;
  if(line.status==='lookup-failed') return `${item}: requested quantity ${qty}; the inventory lookup failed and needs manual confirmation.`;
  return `${item}: requested quantity ${qty}; no unique ERP item was found. Please confirm the exact item code.`;
}

function draftInquiryReply(senderName:string,lines:InquiryLine[],language:string) {
  const details=lines.map(line=>`- ${inventoryText(line,language)}`).join('\n');
  if(language==='zh') return `您好${senderName?`，${senderName}`:''}：\n\n感谢您的询价。我们已检查当前目录和只读库存记录：\n\n${details}\n\n价格和您要求的交付日期仍需人工确认。确认后我们会发送正式报价；本邮件不构成库存预留或交付承诺。\n\n此致\n销售团队`;
  if(language==='de') return `Guten Tag${senderName?` ${senderName}`:''},\n\nvielen Dank für Ihre Anfrage. Wir haben den aktuellen Katalog und die schreibgeschützten Bestandsdaten geprüft:\n\n${details}\n\nPreise und der gewünschte Liefertermin müssen noch bestätigt werden. Danach senden wir Ihnen ein verbindliches Angebot; diese Nachricht reserviert keine Ware und ist keine Lieferzusage.\n\nMit freundlichen Grüßen\nVertriebsteam`;
  if(language==='et') return `Tere${senderName?` ${senderName}`:''},\n\ntäname päringu eest. Kontrollisime praegust kataloogi ja kirjutuskaitstud laoseisu:\n\n${details}\n\nHinnad ja soovitud tarnekuupäev vajavad veel kinnitamist. Seejärel saadame kinnitatud pakkumise; käesolev kiri ei broneeri kaupa ega anna tarnelubadust.\n\nLugupidamisega\nMüügimeeskond`;
  return `Hello${senderName?` ${senderName}`:''},\n\nThank you for your inquiry. We checked the current catalog and read-only inventory records:\n\n${details}\n\nPrices and your requested delivery date still need human confirmation. We will send a confirmed quotation after those checks; this message does not reserve stock or promise delivery.\n\nBest regards,\nSales team`;
}

const templateReplyDrafter:InquiryReplyDrafter=async inquiry=>({
  draft:draftInquiryReply(inquiry.senderName,inquiry.lines,inquiry.replyLanguage),language:inquiry.replyLanguage
});

export function workflow(erp:ERP, saver:SqliteSaver, extract:Extractor=templateExtractor, draftReply:InquiryReplyDrafter=templateReplyDrafter) {
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
      const customerText=value('customer');
      const senderName=s.extracted.facts.sender[0]?.value??'';
      const customerMatches=customers.filter(c=>[c.name,c.customer_name].some(v=>normalize(v)===normalize(customerText)));
      const needs:string[]=[];
      if(customerMatches.length!==1) needs.push('确认客户身份或选择 ERP 客户；这不妨碍先回复一般询价');
      const emailLines=s.extracted.lines.filter(line=>line.description.evidence.source==='email');
      const extractedLines=emailLines.length?emailLines:s.extracted.lines;
      const lines=await Promise.all(extractedLines.map(async line=>{
        const itemText=line.description.value;
        const itemMatches=matchingItems(items,itemText);
        const itemCode=itemMatches.length===1?itemMatches[0].name:'';
        const base={itemText,itemCode,quantity:line.quantity.value};
        if(!itemCode) return {...base,status:'unresolved',inventory:null} as InquiryLine;
        try {
          const stock=await erp.inventory(itemCode);
          const inventory={stockTracked:stock.stockTracked,totalActualQty:stock.totalActualQty};
          const status=!stock.stockTracked||stock.totalActualQty===null?'untracked':stock.totalActualQty===0?'out-of-stock':'recorded-stock';
          return {...base,status,inventory} as InquiryLine;
        } catch {return {...base,status:'lookup-failed',inventory:null} as InquiryLine;}
      }));
      if(lines.some(line=>line.status==='unresolved')) needs.push('确认未能唯一匹配的准确商品编码');
      if(lines.some(line=>line.status==='untracked')) needs.push('库存数量未跟踪，需要人工确认');
      if(lines.some(line=>line.status==='lookup-failed')) needs.push('库存查询失败，需要人工确认');
      needs.push('确认适用价格','确认客户要求的交期能否满足');
      const condition=s.extracted.intent?.evidence.value??'';
      const intent=s.extracted.intent?.kind as InquiryCase['intent'];
      const sourceText=s.sources.find(source=>source.source==='email')?.text??s.sources[0]?.text??'';
      const language=replyLanguage(sourceText,s.extracted.reply?.language);
      const inquiry:InquiryCase={intent,customerText,senderName,
        customer:customerMatches.length===1?customerMatches[0].name:'',lines,condition,requestedDate:value('date'),needs,replyLanguage:language,responseDraft:''};
      return {inquiry,customers,items,issues:[],status:'inquiry-prepared'};
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
    .addEdge('prepareInquiry','draftInquiryReply')
    .addEdge('draftInquiryReply','inquiryReview')
    .addConditionalEdges('inquiryReview',s=>s.status==='inquiry-review'?'inquiryReview':END,['inquiryReview',END])
    .addEdge('match','review')
    .addConditionalEdges('review',s=>s.status==='approved'?'write':s.status==='needs-info'?'review':END,['write','review',END])
    .addConditionalEdges('write',s=>s.status==='created'?END:'review',[END,'review'])
    .compile({checkpointer:saver});
}
