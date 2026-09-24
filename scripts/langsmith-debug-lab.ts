import { Client, RunTree } from 'langsmith';

try {process.loadEnvFile('.env');} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
if(!process.env.LANGSMITH_API_KEY) throw Error('LANGSMITH_API_KEY required');

const project=process.env.LANGSMITH_PROJECT??'order-review-demo';
const client=new Client({apiKey:process.env.LANGSMITH_API_KEY,apiUrl:process.env.LANGSMITH_ENDPOINT});
const batchId=`debug-lab-${new Date().toISOString().replace(/[:.]/g,'-')}`;
const fictionalEmail=(body:string)=>({source:'email',page:0,text:body});

type LabCase={id:string;email:string;intent:'purchase'|'inquiry';expectedLanguage:string;
  itemText:string;itemCode:string;quantity:string;inventoryStatus:'recorded-stock'|'lookup-failed'|'unresolved';stock:number|null;replyLanguage?:string};

const cases:LabCase[]=[
  {id:'good-control',email:'Hello, please order 5 FILTER-A10 units. PO DEMO-TRACE-1. This is fictional.',intent:'purchase',expectedLanguage:'en',
    itemText:'FILTER-A10',itemCode:'FILTER-A10',quantity:'5',inventoryStatus:'recorded-stock',stock:12},
  {id:'erp-tool-error',email:'Hello, is FILTER-A20 available? This is a fictional training email.',intent:'inquiry',expectedLanguage:'en',
    itemText:'FILTER-A20',itemCode:'FILTER-A20',quantity:'10',inventoryStatus:'lookup-failed',stock:null},
  {id:'wrong-reply-language',email:'Hello, could you quote 8 FILTER-A10 units? This is a fictional training email.',intent:'inquiry',expectedLanguage:'en',
    itemText:'FILTER-A10',itemCode:'FILTER-A10',quantity:'8',inventoryStatus:'recorded-stock',stock:12,replyLanguage:'pt'},
  {id:'unresolved-catalog-item',email:'Hello, do you stock 3 Blue Widget Z9 units? This is a fictional training email.',intent:'inquiry',expectedLanguage:'en',
    itemText:'Blue Widget Z9',itemCode:'',quantity:'3',inventoryStatus:'unresolved',stock:null}
];

async function publish(item:LabCase) {
  const root=new RunTree({name:'order-review-debug-lab',run_type:'chain',project_name:project,client,
    tags:['synthetic','training','debug-lab',`case:${item.id}`],metadata:{synthetic:true,batchId,caseId:item.id},
    inputs:{sources:[fictionalEmail(item.email)],expectedLanguage:item.expectedLanguage}});
  await root.postRun();

  const extract=root.createChild({name:'extract',run_type:'chain',inputs:{email:item.email},metadata:{synthetic:true}});
  await extract.postRun();
  await extract.end({intent:item.intent,language:item.expectedLanguage,line:{description:item.itemText,quantity:item.quantity}});
  await extract.patchRun();

  const resolve=root.createChild({name:'resolveInventory',run_type:'chain',inputs:{itemText:item.itemText},metadata:{synthetic:true}});
  await resolve.postRun();
  if(item.itemCode) {
    const tool=resolve.createChild({name:'get_inventory',run_type:'tool',inputs:{itemCode:item.itemCode},metadata:{synthetic:true,readOnly:true}});
    await tool.postRun();
    if(item.inventoryStatus==='lookup-failed') await tool.end(undefined,'ERP_HTTP_503');
    else await tool.end({itemCode:item.itemCode,totalActualQty:item.stock,stockTracked:true});
    await tool.patchRun();
  }
  const availability={itemText:item.itemText,itemCode:item.itemCode,quantity:item.quantity,status:item.inventoryStatus,
    inventory:item.stock===null?null:{stockTracked:true,totalActualQty:item.stock}};
  await resolve.end({availability:[availability]});await resolve.patchRun();

  let replyLanguage:string|undefined;
  if(item.intent==='inquiry') {
    replyLanguage=item.replyLanguage??item.expectedLanguage;
    const reply=root.createChild({name:'draftInquiryReply',run_type:'chain',inputs:{expectedLanguage:item.expectedLanguage,availability:[availability]},metadata:{synthetic:true}});
    await reply.postRun();await reply.end({replyLanguage,draft:`[synthetic ${replyLanguage} reply]`});await reply.patchRun();
  }
  const outputs={status:'review',intent:item.intent,availability,...(replyLanguage?{replyLanguage}:{})};
  await root.end(outputs);await root.patchRun();
  return {caseId:item.id,runId:root.id,traceId:root.trace_id};
}

const runs=[];
for(const item of cases) runs.push(await publish(item));
console.log(JSON.stringify({kind:'Synthetic LangSmith debugging exercise; no model or ERP calls',project,batchId,runs},null,2));
