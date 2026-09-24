import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { traceable } from 'langsmith/traceable';
import { FrappeERP } from '../src/erp.js';
import { geminiInquiryReply, geminiMailExtractor, MODEL_ID } from '../src/model.js';
import { mockERP } from '../src/mock-erp.js';
import { workflow } from '../src/workflow.js';

try {process.loadEnvFile('.env');} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
if(!process.env.GOOGLE_API_KEY) throw Error('GOOGLE_API_KEY required');
if(!process.env.LANGSMITH_API_KEY) throw Error('LANGSMITH_API_KEY required');

const project=process.env.LANGSMITH_BLIND_PROJECT??'order-review-mailbox-lab';
process.env.LANGSMITH_PROJECT=project;
process.env.LANGSMITH_TRACING='true';
process.env.ORDER_TRACE='true';

const caseId='MAIL-2026-0924-002';
const threadId=randomUUID();
const runId=randomUUID();
const dataDir=resolve('data','langsmith-blind-mail');
await mkdir(dataDir,{recursive:true});

const mail={
  messageId:`<${caseId.toLowerCase()}@meridian-fleet.example>`,
  receivedAt:'2026-09-24T11:18:00Z',
  from:'Olivia Hart <olivia.hart@meridian-fleet.example>',
  to:'orders@demo-parts.example',
  subject:'November workshop stock check',
  body:`Hi,

Following up on our call, could you send a quote and let me know what you actually have available for our November service work?

- 18 x Filter A20
- 6 x A-series filters for the older service vans — I don't have the exact code handy

If the full shipment can reach 100 Demo Industrial Way, Austin, TX 78701 by November 12, we'd like to move forward. Please check before we issue our PO.

Thanks,
Olivia Hart
Purchasing Coordinator
Meridian Fleet Services`
};

const mock=await mockERP();
const saver=SqliteSaver.fromConnString(resolve(dataDir,'checkpoints.sqlite'));
const erp=new FrappeERP(mock.url,'token training:training','Nordic Parts Demo',3000);
const graph=workflow(erp,saver,geminiMailExtractor(dataDir),geminiInquiryReply(dataDir));
const config={
  configurable:{thread_id:threadId},
  runName:'order-review-workflow',
  tags:['synthetic','training','blind-mail-review'],
  metadata:{caseId,threadId,sourceSystem:'fictional-mailbox',erpSystem:'local-fixture-http',model:MODEL_ID}
};

const run=traceable(async(input:{mail:typeof mail})=>{
  const result=await graph.invoke({sources:[{source:'email' as const,page:0,text:input.mail.body}]},config);
  const state=await graph.getState(config);
  return {threadId,state:state.values,pendingInterrupts:state.tasks.flatMap(task=>task.interrupts.map(item=>item.value)),invokeResult:result};
},{
  id:runId,name:caseId,run_type:'chain',project_name:project,
  tags:['synthetic','training','blind-mail-review'],
  metadata:{caseId,threadId,sourceSystem:'fictional-mailbox',erpSystem:'local-fixture-http',model:MODEL_ID}
});

try {
  const result=await run({mail});
  console.log(JSON.stringify({project,caseId,runId,threadId,model:MODEL_ID,status:result.state.status,pendingInterrupts:result.pendingInterrupts.length},null,2));
} catch(error) {
  console.error(JSON.stringify({project,caseId,runId,threadId,model:MODEL_ID,error:error instanceof Error?error.message:'Unknown error',retryAttempted:false},null,2));
  process.exitCode=1;
} finally {
  saver.db.close();
  await mock.close();
}
