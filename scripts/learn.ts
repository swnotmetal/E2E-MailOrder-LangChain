import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Command } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { z } from 'zod';
import { mockERP } from '../src/mock-erp.js';
import { FrappeERP } from '../src/erp.js';
import { workflow } from '../src/workflow.js';
import { readSources } from '../src/input.js';
import { DecisionSchema, InquiryDecisionSchema, type Decision, type InquiryDecision } from '../src/domain.js';
import { inventoryTool, geminiInquiryReply, geminiMailExtractor, recordHumanReviewFeedback } from '../src/model.js';
import { resolve } from 'node:path';

export async function startLearningLab(port=3210) {
  const traceProject=process.env.LEARN_LANGSMITH_PROJECT?.trim()||process.env.LANGSMITH_PROJECT?.trim()||'order-review-mailbox-ui';
  process.env.LANGSMITH_PROJECT=traceProject;
  const configureTracing=()=>{
    const enabled=process.env.ORDER_TRACE==='true'&&!!process.env.LANGSMITH_API_KEY;
    process.env.LANGSMITH_TRACING=enabled?'true':'false';process.env.LANGCHAIN_TRACING_V2=enabled?'true':'false';
  };
  configureTracing();
  const remoteMockBase=process.env.LEARN_ERP_BASE_URL?.trim();
  const ownedMock=remoteMockBase?null:await mockERP();
  const erpBase=remoteMockBase||ownedMock!.url;
  const erp=new FrappeERP(erpBase,process.env.LEARN_ERP_AUTH??'token test:test',process.env.LEARN_ERP_COMPANY??'Nordic Parts Demo');
  const resetMock=async()=>{
    if(ownedMock) {ownedMock.reset();return;}
    const response=await fetch(`${erpBase}/__mock/reset`,{method:'POST'});
    if(!response.ok) throw Error(`MOCK_RESET_HTTP_${response.status}`);
  };
  const mockWrites=async()=>{
    if(ownedMock) return ownedMock.posts;
    const response=await fetch(`${erpBase}/__mock/status`);
    if(!response.ok) throw Error(`MOCK_STATUS_HTTP_${response.status}`);
    return Number((await response.json() as {posts:number}).posts);
  };
  const saver=SqliteSaver.fromConnString(':memory:');
  const graph=workflow(erp,saver);
  const modelGraph=workflow(erp,saver,geminiMailExtractor(resolve('data')),geminiInquiryReply(resolve('data')));
  const threads=new Set<string>();
  const mailbox=new Map<string,{subject:string;events:unknown[];error?:string}>();
  const inventory=inventoryTool(erp);
  let busy=false;
  const server=createServer(async(req,res)=>{
    const host=`127.0.0.1:${(server.address() as {port:number}).port}`;
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    try {
      if(req.headers.host!==host || (req.headers.origin && req.headers.origin!==`http://${host}`)) {
        res.writeHead(403).end(JSON.stringify({error:'LOCAL_ORIGIN_ONLY'}));return;
      }
      if(req.method==='GET' && req.url==='/') {
        res.setHeader('Content-Type','text/html; charset=utf-8');
        res.end(await readFile(new URL('../src/learn.html',import.meta.url)));return;
      }
      if(req.method!=='POST' || !['/api/start','/api/send','/api/inbox','/api/template','/api/decide','/api/state','/api/tool','/api/reset'].includes(req.url??'')) {
        res.writeHead(404).end('{}');return;
      }
      if(!req.headers['content-type']?.startsWith('application/json')) throw Error('JSON_REQUIRED');
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req) {size+=chunk.length;if(size>32768) throw Error('INPUT_TOO_LARGE');chunks.push(chunk);}
      const input=JSON.parse(Buffer.concat(chunks).toString());
      if(busy) {res.writeHead(409).end(JSON.stringify({error:'LAB_BUSY'}));return;}
      busy=true;
      try {
        const events:unknown[]=[];
        if(req.url==='/api/template') {
          const fixture=z.enum(['01-clean','02-ambiguous','03-quantity-conflict']).parse(input.fixture);
          res.end(JSON.stringify({sources:await readSources(`fixtures/${fixture}.eml`,`fixtures/${fixture}.pdf`)}));return;
        }
        if(req.url==='/api/inbox') {
          const messages=[];
          for(const [id,mail] of mailbox) {
            const state=await graph.getState({configurable:{thread_id:id}});
            messages.push({id,subject:mail.subject,status:mail.error?'error':state.values.status,order:state.values.order,error:mail.error});
          }
          res.end(JSON.stringify({messages}));return;
        }
        if(req.url==='/api/tool') {
          const output=await inventory.invoke(input);
          res.end(JSON.stringify({mode:'MOCK inventory / real LangChain tool / no model',schema:z.toJSONSchema(inventory.schema),input,output}));return;
        }
        if(req.url==='/api/reset') {
          await resetMock();threads.clear();mailbox.clear();
          res.end(JSON.stringify({reset:true,mockWrites:0,message:'练习数据已清空'}));return;
        }
        let id:string, humanDecision:Decision|InquiryDecision|undefined;
        let feedback:undefined|{id?:string;error?:string};
        if(req.url==='/api/send') {
          const mail=z.object({subject:z.string().trim().min(1).max(160),email:z.string().min(1).max(12000),attachment:z.string().max(12000),mode:z.enum(['template','gemini']).default('template')}).parse(input);
          id=randomUUID();threads.add(id);mailbox.set(id,{subject:mail.subject,events});
          const sources=[{source:'email' as const,page:0,text:mail.email},...(mail.attachment.trim()?[{source:'pdf' as const,page:1,text:mail.attachment}]:[])];
          try {
            if(mail.mode==='gemini') {try{process.loadEnvFile('.env');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}configureTracing();}
            for await(const event of await (mail.mode==='gemini'?modelGraph:graph).stream({sources},{configurable:{thread_id:id},streamMode:'updates',
              runName:`mailbox · ${mail.subject}`,tags:['fictional-email','learning-lab','source:web-ui'],metadata:{thread_id:id,subject:mail.subject,sourceSystem:'web-ui'}})) events.push(event);
          } catch(error) {mailbox.get(id)!.error=error instanceof Error?error.message:'Unknown error';}
        } else if(req.url==='/api/start') {
          const {fixture}=z.object({fixture:z.enum(['01-clean','02-ambiguous','03-quantity-conflict'])}).parse(input);
          await resetMock();threads.clear();mailbox.clear();
          id=randomUUID();threads.add(id);
          const sources=await readSources(`fixtures/${fixture}.eml`,`fixtures/${fixture}.pdf`);
          for await(const event of await graph.stream({sources},{configurable:{thread_id:id},streamMode:'updates',
            runName:`fixture · ${fixture}`,tags:['fictional-email','learning-lab','template','source:web-ui'],metadata:{thread_id:id,fixture,sourceSystem:'web-ui'}})) events.push(event);
        } else {
          id=z.string().uuid().parse(input.id);if(!threads.has(id)) throw Error('UNKNOWN_SESSION');
          if(req.url==='/api/decide') {
            const current=await graph.getState({configurable:{thread_id:id}});
            if(!current.tasks.some(t=>t.interrupts.length)) throw Error('NO_PENDING_REVIEW');
            const pending=current.tasks.flatMap(t=>t.interrupts.map(i=>i.value))[0] as {kind?:string};
            const decision=(pending.kind==='inquiry'?InquiryDecisionSchema:DecisionSchema).parse(input.decision);
            humanDecision=decision;
            for await(const event of await graph.stream(new Command({resume:decision}),{configurable:{thread_id:id},streamMode:'updates',
              runName:`mailbox review · ${mailbox.get(id)?.subject??id}`,tags:['fictional-email','learning-lab','human-review','source:web-ui'],metadata:{thread_id:id,subject:mailbox.get(id)?.subject??'',sourceSystem:'web-ui'}})) events.push(event);
          }
        }
        const state=await graph.getState({configurable:{thread_id:id}});
        if(humanDecision) {
          const runId=state.values.inquiry?.replyTraceId??state.values.extracted?.traceId;
          if(runId) try {
            const correction='responseDraft' in humanDecision?{responseDraft:humanDecision.responseDraft}:{draft:humanDecision.draft};
            feedback={id:await recordHumanReviewFeedback(runId,{action:humanDecision.action,actor:humanDecision.actor,reason:humanDecision.reason,correction})};
          } catch(error) {feedback={error:error instanceof Error?error.message:'Unknown feedback error'};}
        }
        const mail=mailbox.get(id);
        if(mail && mail.events!==events) mail.events.push(...events);
        res.end(JSON.stringify({id,error:mail?.error,feedback,mode:'Mock ERP / real LangGraph / optional Gemini',tracing:process.env.LANGSMITH_TRACING==='true',traceProject,events:mail?.events??events,values:state.values,next:state.next,
          pending:state.tasks.flatMap(t=>t.interrupts.map(i=>i.value)),mockWrites:await mockWrites()}));
      } finally {busy=false;}
    } catch(error) {res.writeHead(400).end(JSON.stringify({error:error instanceof Error?error.message:'Unknown error'}));}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,
    close:async()=>{await new Promise<void>(r=>server.close(()=>r()));saver.db.close();if(ownedMock) await ownedMock.close();}};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {process.loadEnvFile('.env');} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const lab=await startLearningLab();console.log(`Learning lab: ${lab.url} (${process.env.LEARN_ERP_BASE_URL?'external':'embedded'} mock ERP; optional live Gemini; restart clears practice state)`);
  process.once('SIGINT',()=>{void lab.close();});
}
