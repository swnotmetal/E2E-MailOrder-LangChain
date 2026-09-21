import { mkdir, readFile, writeFile, appendFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Command } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { readSources } from './input.js';
import { digest, DecisionSchema } from './domain.js';
import { FrappeERP } from './erp.js';
import { workflow } from './workflow.js';
import { geminiExtractor, geminiInventoryAnswer } from './model.js';

const [command,...args] = process.argv.slice(2);
const dir=resolve(process.env.ORDER_DATA_DIR??'data');
await mkdir(dir,{recursive:true});
if(process.env.ORDER_EXTRACTOR==='gemini' || command==='inventory') process.loadEnvFile('.env');
if(process.env.ORDER_EXTRACTOR && !['template','gemini'].includes(process.env.ORDER_EXTRACTOR)) throw Error('Only ORDER_EXTRACTOR=gemini (Gemini 2.5 Flash-Lite) or template is supported');
if(process.env.ERP_ENV_FILE) process.loadEnvFile(process.env.ERP_ENV_FILE);
if(process.env.ORDER_TRACE!=='true') process.env.LANGSMITH_TRACING='false';
const base=process.env.ERP_URL??'http://127.0.0.1:8080';
const token=process.env.ERP_TOKEN;
if(!token) throw Error('Set ERP_TOKEN as api_key:api_secret in the process environment (or ERP_ENV_FILE pointing to ignored .env)');
const erp=new FrappeERP(base,`token ${token}`,process.env.ERP_COMPANY??'Nordic Parts Demo');
// ponytail: one local operator at a time; OS releases SQLite transaction locks on process death.
// Separate lock DB allows LangGraph checkpoints to commit durably during the run.
const lock=SqliteSaver.fromConnString(resolve(dir,'operator-lock.sqlite'));
const saver=SqliteSaver.fromConnString(resolve(dir,'checkpoints.sqlite'));
lock.db.pragma('busy_timeout = 100');
const started=performance.now();
try {
  lock.db.exec('BEGIN IMMEDIATE');
  const graph=workflow(erp,saver,process.env.ORDER_EXTRACTOR==='gemini'?geminiExtractor(dir):undefined);
  if(command==='import') {
    if(args.length!==2) throw Error('Usage: import email.eml purchase-order.pdf');
    const sources=await readSources(args[0],args[1]);
    const id=digest(sources);
    console.error(`thread_id=${id}`);
    const config={configurable:{thread_id:id}};
    if(!(await graph.getState(config)).values.sources) {
      await writeFile(resolve(dir,`${id}.sources.json`),JSON.stringify(sources,null,2));
      await copyFile(args[0],resolve(dir,`${id}.eml`));
      await copyFile(args[1],resolve(dir,`${id}.pdf`));
      await graph.invoke({sources},config);
    }
    const snapshot=await graph.getState(config);
    console.log(JSON.stringify({id,...snapshot.values,pendingReview:snapshot.tasks.flatMap(t=>t.interrupts.map(i=>i.value))},null,2));
  } else if(['show','review','decide','retry'].includes(command)) {
    const [id,path]=args;
    if(!/^[a-f0-9]{64}$/.test(id??'')) throw Error('Invalid thread id');
    const config={configurable:{thread_id:id}};
    const state=await graph.getState(config);
    if(!state.values.sources) throw Error('Unknown thread');
    if(command==='review') {
      if(!path) throw Error('Usage: review thread-id output.json');
      await writeFile(path,JSON.stringify({action:'request-info',revision:state.values.revision,actor:'local-operator',reason:'',draft:state.values.draft},null,2),{flag:'wx'});
    }
    if(command==='decide') {
      const decision=DecisionSchema.parse(JSON.parse(await readFile(path,'utf8')));
      if(!['created','rejected'].includes(state.values.status)) {
        if(!state.tasks.some(t=>t.interrupts?.length)) throw Error('No pending review; use retry after fixing ERP connectivity');
        await graph.invoke(new Command({resume:decision}),config);
      } // Repeated approval is a no-op after a terminal state.
    }
    if(command==='retry') {
      if(state.tasks.some(t=>t.interrupts?.length)) throw Error('Human review pending; use decide');
      if(state.next.length) await graph.invoke(null,config);
    }
    const snapshot=await graph.getState(config);
    console.log(JSON.stringify({id,...snapshot.values,pendingReview:snapshot.tasks.flatMap(t=>t.interrupts.map(i=>i.value))},null,2));
  } else if(command==='inventory') {
    if(!args.length) throw Error('Usage: inventory <fictional question>');
    console.log(JSON.stringify(await geminiInventoryAnswer(args.join(' '),erp,dir),null,2));
  } else throw Error('Commands: import <eml> <pdf> | show <id> | review <id> <new.json> | decide <id> <json> | retry <id> | inventory <fictional question>');
  let modelCalls=0,modelCostUSD=0;
  if(process.env.ORDER_EXTRACTOR==='gemini' || command==='inventory') {
    const modelLedger=SqliteSaver.fromConnString(resolve(dir,'model-budget.sqlite'));
    try {
      const row=modelLedger.db.prepare('SELECT COUNT(*) AS calls, COALESCE(SUM(actual_usd_micro),0) AS micro FROM model_budget').get() as {calls:number;micro:number};
      modelCalls=row.calls;modelCostUSD=row.micro/1e6;
    } finally {modelLedger.db.close();}
  }
  await appendFile(resolve(dir,'runs.jsonl'),JSON.stringify({command,elapsedMs:Math.round(performance.now()-started),modelCallsCumulative:modelCalls,modelCostUSDCumulative:modelCostUSD,timestamp:new Date().toISOString()})+'\n');
} catch(e) {
  console.error(e instanceof Error?e.message:'Unknown error'); process.exitCode=1;
} finally {
  if(lock.db.inTransaction) lock.db.exec('ROLLBACK');
  saver.db.close(); lock.db.close();
}

