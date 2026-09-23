import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLearningLab } from '../scripts/learn.js';
import { mockERP } from '../src/mock-erp.js';

test('learning UI API validates tools, pauses graph, resumes human review and blocks foreign origins',async()=>{
  const lab=await startLearningLab(0);
  const post=async(path:string,body:unknown)=>{
    const response=await fetch(lab.url+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json() as any};
  };
  try {
    const html=await (await fetch(lab.url)).text();
    assert.match(html,/LangChain/);assert.match(html,/scenario'\)\.onchange/);assert.match(html,/请选择样例或发送自然语言邮件/);
    assert.match(html,/understanding-error/);assert.match(html,/reply-error/);assert.match(html,/回复生成失败/);
    assert.match(html,/LangSmith feedback 已记录/);
    assert.match(html,/目录与库存查询没有运行/);assert.match(html,/id="inquiryLines"/);
    assert.equal((await post('tool',{itemCode:42})).status,400);
    const tool=await post('tool',{itemCode:'FILTER-A10'});
    assert.equal(tool.data.output.totalActualQty,12);
    assert.equal((await post('start',{fixture:'../../.env'})).status,400);
    const started=(await post('start',{fixture:'03-quantity-conflict'})).data;
    assert.equal(started.values.status,'review');assert.equal(started.mockWrites,0);
    assert.ok(started.pending.length);assert.ok(started.events.some((e:any)=>e.extract));
    const decision={action:'approve',revision:started.values.revision,actor:'test',reason:'',draft:started.values.draft};
    const held=(await post('decide',{id:started.id,decision})).data;
    assert.match(held.pending[0].feedback,/RESOLUTION_REASON_REQUIRED/);assert.equal(held.mockWrites,0);
    decision.reason='Fictional exercise: checked PDF quantity';
    const done=(await post('decide',{id:started.id,decision})).data;
    assert.equal(done.values.status,'created');assert.equal(done.mockWrites,1);
    assert.equal((await post('decide',{id:started.id,decision})).status,400);
    assert.equal((await post('state',{id:started.id})).data.values.status,'created');
    const restarted=(await post('start',{fixture:'03-quantity-conflict'})).data;
    assert.equal(restarted.mockWrites,0);
    assert.ok(!restarted.values.issues.some((issue:any)=>issue.code==='DUPLICATE_PO'));
    assert.equal((await post('state',{id:started.id})).status,400);
    const reset=await post('reset',{});assert.equal(reset.data.mockWrites,0);
    assert.equal((await post('state',{id:restarted.id})).status,400);
    const template=(await post('template',{fixture:'01-clean'})).data;
    const mail={subject:'Fictional inbox order',email:template.sources[0].text,attachment:template.sources.slice(1).map((s:any)=>s.text).join('\n')};
    const first=(await post('send',mail)).data;
    assert.equal(first.values.status,'review');
    const approved=(await post('decide',{id:first.id,decision:{action:'approve',revision:first.values.revision,actor:'test',reason:'Checked fictional order',draft:first.values.draft}})).data;
    assert.equal(approved.values.status,'created');
    const duplicate=(await post('send',mail)).data;
    assert.ok(duplicate.values.issues.some((i:any)=>i.code==='DUPLICATE_PO'));
    assert.equal((await post('inbox',{})).data.messages.length,2);
    assert.equal((await post('state',{id:first.id})).data.values.status,'created');
    assert.ok((await post('state',{id:first.id})).data.events.some((e:any)=>e.extract));
    await post('reset',{});
    assert.equal((await post('inbox',{})).data.messages.length,0);
    const blocked=await fetch(lab.url+'/api/tool',{method:'POST',headers:{Origin:'https://example.com','Content-Type':'application/json'},body:'{}'});
    assert.equal(blocked.status,403);
  } finally {await lab.close();}
});

test('learning lab can use a separately hosted fictional ERP process',async()=>{
  const erp=await mockERP();
  const previous=process.env.LEARN_ERP_BASE_URL;
  process.env.LEARN_ERP_BASE_URL=erp.url;
  let lab:Awaited<ReturnType<typeof startLearningLab>>|undefined;
  try {
    lab=await startLearningLab(0);
    const response=await fetch(lab.url+'/api/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fixture:'01-clean'})});
    const data=await response.json() as any;
    assert.equal(response.status,200);assert.equal(data.values.status,'review');assert.equal(data.mockWrites,0);
    const status=await (await fetch(erp.url+'/__mock/status')).json() as {posts:number};
    assert.equal(status.posts,0);
  } finally {
    if(previous===undefined) delete process.env.LEARN_ERP_BASE_URL; else process.env.LEARN_ERP_BASE_URL=previous;
    if(lab) await lab.close();
    await erp.close();
  }
});
