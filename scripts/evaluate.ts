import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { z } from 'zod';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { FrappeERP } from '../src/erp.js';
import { readSources } from '../src/input.js';
import { workflow } from '../src/workflow.js';

// Gold labels must be provided/verified by a human. This runner never creates labels or approves orders.
const schema=z.object({humanVerified:z.literal(true),verifiedBy:z.string().min(1),cases:z.array(z.object({
  id:z.string(),email:z.string(),pdf:z.string(),fields:z.record(z.string(),z.string()),issueCodes:z.array(z.string())
})).min(1)});
const file=process.argv[2];if(!file) throw Error('Usage: npm run evaluate -- human-verified-gold.json');
const gold=schema.parse(JSON.parse(await readFile(file,'utf8')));
if(process.env.ERP_ENV_FILE) process.loadEnvFile(process.env.ERP_ENV_FILE);
if(!process.env.ERP_TOKEN) throw Error('ERP_TOKEN required; evaluation only reads ERP data');
const erp=new FrappeERP(process.env.ERP_URL??'http://127.0.0.1:8080',`token ${process.env.ERP_TOKEN}`,process.env.ERP_COMPANY??'Nordic Parts Demo');
const results=[];
for(const c of gold.cases) {
  const saver=SqliteSaver.fromConnString(':memory:');const start=performance.now();
  try {
    const graph=workflow(erp,saver),config={configurable:{thread_id:c.id}};
    await graph.invoke({sources:await readSources(c.email,c.pdf)},config);
    const s=await graph.getState(config);
    const wrong=Object.entries(c.fields).filter(([path,expected])=>{
      const actual=path.split('.').reduce((obj,key)=>obj?.[key],s.values.draft);
      return actual!==expected;
    }).map(([path])=>path);
    const detected=new Set<string>(s.values.issues.map((i:{code:string})=>i.code));
    results.push({id:c.id,fields:c.fields,fieldCount:Object.keys(c.fields).length,wrongFields:wrong,
      missedIssues:c.issueCodes.filter(code=>!detected.has(code)),extraIssues:[...detected].filter(code=>!c.issueCodes.includes(code)),
      elapsedMs:Math.round(performance.now()-start),modelCalls:0,modelCostUSD:0,
      minimumFieldCorrections:wrong.length,actualHumanEdits:null,duplicateOrders:null});
  } catch(error) {
    results.push({id:c.id,error:error instanceof Error?error.message:'Unknown error',elapsedMs:Math.round(performance.now()-start)});
  } finally{saver.db.close();}
}
const report={kind:'human-verified-gold evaluation; no ERP writes',verifiedBy:gold.verifiedBy,results};
await mkdir('data',{recursive:true});
await writeFile('data/evaluation.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
