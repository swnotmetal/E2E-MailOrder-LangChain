import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'langsmith';
import { evaluate } from 'langsmith/evaluation';
import { geminiMailExtractor, MODEL_ID } from '../src/model.js';
import { assertSourcesAreFictional, extractionScores, normalizeExtraction, readEvaluationFixture, type ExpectedExtraction } from '../src/evaluation.js';

const DATASET='fictional-multilingual-inquiry-regression';
const FIXTURE=resolve('fixtures/evaluation/multilingual-inquiries.json');
const loadEnv=()=>{try{process.loadEnvFile('.env');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}};
const client=()=>new Client({apiKey:process.env.LANGSMITH_API_KEY,apiUrl:process.env.LANGSMITH_ENDPOINT});
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
const stable=(value:unknown)=>JSON.stringify(canonical(value));

async function seed(c:Client) {
  const fixture=await readEvaluationFixture(FIXTURE);
  const dataset=await c.hasDataset({datasetName:DATASET})?await c.readDataset({datasetName:DATASET}):await c.createDataset(DATASET,{
    description:'Four fictional multilingual inquiry emails explicitly requested as a human-confirmed regression set. No ERP writes.',
    dataType:'kv',metadata:{humanVerified:true,verifiedBy:fixture.verifiedBy,verificationDate:fixture.verificationDate,modelPolicy:MODEL_ID}
  });
  const existing=new Map<string,any>();
  for await(const example of c.listExamples({datasetId:dataset.id})) if(example.metadata?.caseId)existing.set(String(example.metadata.caseId),example);
  let created=0,updated=0,unchanged=0;
  for(const item of fixture.cases) {
    const upload={inputs:{caseId:item.id,sources:item.inputs.sources},outputs:item.expected,
      metadata:{caseId:item.id,humanVerified:true,verifiedBy:fixture.verifiedBy,verificationDate:fixture.verificationDate},split:'regression'};
    const old=existing.get(item.id);
    if(!old){await c.createExample({...upload,dataset_id:dataset.id});created++;continue;}
    const managedMetadata=Object.fromEntries(Object.keys(upload.metadata).map(key=>[key,old.metadata?.[key]]));
    if(stable(old.inputs)===stable(upload.inputs)&&stable(old.outputs)===stable(upload.outputs)&&stable(managedMetadata)===stable(upload.metadata)){unchanged++;continue;}
    await c.updateExample({id:old.id,dataset_id:dataset.id,...upload});updated++;
  }
  return {datasetId:dataset.id,datasetName:DATASET,cases:fixture.cases.length,created,updated,unchanged};
}

const evaluator=({outputs,referenceOutputs}:{outputs:Record<string,unknown>;referenceOutputs?:Record<string,unknown>})=>({
  results:Object.entries(extractionScores(outputs,referenceOutputs as ExpectedExtraction)).map(([key,score])=>({key,score}))
});
const summary=({outputs,referenceOutputs}:{outputs:Record<string,unknown>[];referenceOutputs?:Record<string,unknown>[]})=>{
  const rows=outputs.map((output,index)=>extractionScores(output,referenceOutputs?.[index] as ExpectedExtraction));
  return {key:'dataset_pass_rate',score:rows.length?rows.reduce((sum,row)=>sum+row.regression_pass,0)/rows.length:0};
};
async function consume(result:any):Promise<{experimentName:string;rows:any[];summary:any}> {
  const rows=(result.results??[]).map((row:any)=>({exampleId:row.example.id,runId:row.run.id,error:row.run.error??null,
    scores:row.evaluationResults.results.map((score:any)=>({key:score.key,score:score.score}))}));
  return {experimentName:(result as any).experimentName,rows,summary:(result as any).summaryResults};
}

async function compare(c:Client,baseline:string,candidate:string,fixture:Awaited<ReturnType<typeof readEvaluationFixture>>) {
  const byId=new Map(fixture.cases.map(item=>[item.id,item]));
  return evaluate([baseline,candidate],{client:c,experimentPrefix:'mail-understanding-version-comparison',
    description:'Deterministic comparison against human-confirmed reference outputs.',randomizeOrder:false,
    evaluators:[({runs,inputs,outputs,referenceOutputs}:{runs:{id:string}[];inputs:Record<string,unknown>;outputs:Record<string,unknown>[];referenceOutputs?:Record<string,unknown>})=>{
      const reference=(referenceOutputs??byId.get(String(inputs.caseId))?.expected) as ExpectedExtraction;
      return {key:'reference_quality',scores:Object.fromEntries(runs.map((run,index)=>{const scores=extractionScores(outputs[index],reference);return [run.id,Object.values(scores).reduce((a,b)=>a+b,0)/Object.values(scores).length];}))};
    }]});
}

async function runDemo(c:Client) {
  const fixture=await readEvaluationFixture(FIXTURE);const byId=new Map(fixture.cases.map(item=>[item.id,item]));
  await seed(c);
  const common={data:DATASET,evaluators:[evaluator],summaryEvaluators:[summary],client:c,maxConcurrency:1,
    metadata:{dataset:DATASET,humanVerified:true,fixedModel:MODEL_ID},description:'Fictional multilingual email extraction regression; no ERP writes.'};
  const baseline=await consume(await evaluate(async(input:any)=>byId.get(input.caseId)?.historical??{status:'error',error:'HISTORICAL_CASE_NOT_FOUND'},
    {...common,experimentPrefix:'mail-understanding-historical-2026-09-23'}));
  process.env.ORDER_TRACE='true';process.env.LANGSMITH_TRACING='true';process.env.LANGCHAIN_TRACING_V2='true';
  const extract=geminiMailExtractor('data/langsmith-evaluation-ledger');
  const candidate=await consume(await evaluate(async(input:any)=>{assertSourcesAreFictional(input.sources);return normalizeExtraction(await extract(input.sources));},
    {...common,experimentPrefix:'mail-understanding-current',metadata:{...common.metadata,variant:'current-grounded-extractor'}}));
  const comparison=await compare(c,baseline.experimentName,candidate.experimentName,fixture);
  const report={kind:'LangSmith dataset and experiments; fictional data; no ERP writes',dataset:DATASET,baseline,candidate,
    comparison:{experimentName:comparison.experimentName,url:comparison.url,rows:comparison.results.length},model:MODEL_ID};
  await mkdir('data',{recursive:true});await writeFile('data/langsmith-evaluation.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}

loadEnv();
if(!process.env.LANGSMITH_API_KEY)throw Error('LANGSMITH_API_KEY required');
const command=process.argv[2]??'demo';
if(command==='seed')console.log(JSON.stringify(await seed(client()),null,2));
else if(command==='demo'){if(!process.env.GOOGLE_API_KEY)throw Error('GOOGLE_API_KEY required for current experiment');await runDemo(client());}
else if(command==='compare'){
  const baseline=process.argv[3],candidate=process.argv[4];if(!baseline||!candidate)throw Error('compare requires baseline and candidate experiment names');
  const result=await compare(client(),baseline,candidate,await readEvaluationFixture(FIXTURE));
  console.log(JSON.stringify({experimentName:result.experimentName,url:result.url,rows:result.results.length},null,2));
} else throw Error('Usage: npm run eval:langsmith -- seed|demo|compare <baseline> <candidate>');
