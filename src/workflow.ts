import { Annotation, StateGraph, START, END, interrupt } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { type ERP } from './erp.js';
import { templateExtractor, verifyEvidence, type Extractor } from './input.js';
import { type Source, type Extraction, type Draft, type Issue, type Customer, type Item, type Address, type Decision,
  DecisionSchema, validate, normalize, digest, fields } from './domain.js';

const State = Annotation.Root({
  sources:Annotation<Source[]>(), extracted:Annotation<Extraction>(), draft:Annotation<Draft>(),
  customers:Annotation<Customer[]>(), items:Annotation<Item[]>(), addresses:Annotation<Address[]>(),
  issues:Annotation<Issue[]>(), status:Annotation<string>(), revision:Annotation<string>(),
  decision:Annotation<Decision>(), order:Annotation<string>(), audit:Annotation<Decision[]>({reducer:(a,b)=>a.concat(b),default:()=>[]})
});
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
          const exact=items.filter(i=>normalize(i.name)===normalize(l.description.value));
          return {description:l.description.value,item:exact.length===1?exact[0].name:'',quantity:l.quantity.value,unit:l.unit.value};
        })};
      issues.push(...await checkERP(draft));
      if(draft.customer && draft.po && (await erp.duplicates(draft)).length) issues.push({code:'DUPLICATE_PO',field:'po',message:'ERP already contains this customer PO; commit will reconcile only an identical integration draft'});
      return {draft,customers,items,addresses,issues,revision:digest([s.sources,draft]),status:'review'};
    })
    .addNode('review',s=>{
      let decision:Decision;
      let feedback='';
      for (;;) {
        const parsed=DecisionSchema.safeParse(interrupt({revision:s.revision,draft:s.draft,issues:s.issues,customers:s.customers,items:s.items,addresses:s.addresses,status:s.status,feedback}));
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
    .addEdge(START,'extract').addEdge('extract','match').addEdge('match','review')
    .addConditionalEdges('review',s=>s.status==='approved'?'write':s.status==='needs-info'?'review':END,['write','review',END])
    .addConditionalEdges('write',s=>s.status==='created'?END:'review',[END,'review'])
    .compile({checkpointer:saver});
}
