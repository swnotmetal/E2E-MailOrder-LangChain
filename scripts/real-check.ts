import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { FrappeERP } from '../src/erp.js';
import { verifyEvidence } from '../src/input.js';
import { validate } from '../src/domain.js';
process.loadEnvFile('.env.erp');
const id=process.argv[2];if(!/^[a-f0-9]{64}$/.test(id??'')) throw Error('Expected import thread id');
const saver=SqliteSaver.fromConnString('data/checkpoints.sqlite');
try {
  const snapshot=await saver.getTuple({configurable:{thread_id:id}});
  if(!snapshot) throw Error('No persisted thread');
  const state=(snapshot.checkpoint.channel_values as Record<string,any>);
  verifyEvidence(state.extracted,state.sources);
  const erp=new FrappeERP(process.env.ERP_URL!,`token ${process.env.ERP_TOKEN}`,process.env.ERP_COMPANY!);
  const draft=state.draft;
  const [customers,items,addresses,duplicates,prices]=await Promise.all([
    erp.customers(),erp.items(),erp.addresses(draft.customer),erp.duplicates(draft),
    erp.list<{item_code:string;price_list_rate:number;currency:string}>('Item Price',['item_code','price_list_rate','currency'],[['item_code','=',draft.lines[0].item],['price_list','=','Nordic Demo EUR']]).catch(()=>null)
  ]);
  console.log(JSON.stringify({id,status:state.status,draft,issues:state.issues,
    evidenceCount:Object.values(state.extracted.facts).flat().length+state.extracted.lines.length*3,
    exactCustomerMatch:customers.some(c=>c.name===draft.customer),exactItemMatch:items.some(i=>i.name===draft.lines[0].item),
    linkedAddress:addresses.some(a=>a.name===draft.address),duplicateOrders:duplicates.length,
    catalogPrice:prices,priceReadAuthorized:prices!==null,deterministicIssues:validate(draft)},null,2));
}finally{saver.db.close();}

