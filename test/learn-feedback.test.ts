import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('learning feedback distinguishes edited, blocked and successfully approved drafts',()=>{
  const nodes=new Map<string,any>();
  const get=(id:string)=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',hidden:false,className:'',addEventListener(){}});return nodes.get(id);};
  get('fixture').value='02-ambiguous';
  const html=readFileSync('src/learn.html','utf8');
  const context={document:{getElementById:get,querySelectorAll:()=>[],querySelector:()=>get('action')}};
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1]+`
    const base={id:'test',next:['review'],mockWrites:0,events:[],pending:[{feedback:''}],values:{status:'review',sources:[],issues:[{code:'UNRESOLVED_ITEM'}],items:[{name:'FILTER-A10'}],draft:{lines:[{item:''}]}}};
    render(base);
    $('draft').value=JSON.stringify({lines:[{item:'FILTER-A10'}]});edited();
  `,context);
  assert.match(get('editFeedback').textContent,/已识别.*FILTER-A10/);
  assert.match(get('editFeedback').textContent,/尚未提交/);
  assert.match(get('blocker').className,/notice/);
  runInNewContext(`render({...base,pending:[{feedback:'RESOLUTION_REASON_REQUIRED'}]},$('draft').value);`,context);
  assert.match(get('editFeedback').textContent,/缺少审核理由/);
  assert.match(get('draft').value,/FILTER-A10/);
  runInNewContext(`render({...base,next:[],pending:[],values:{...base.values,status:'created',order:'MOCK-SO-1',issues:[]}});`,context);
  assert.match(get('lesson').textContent,/批准成功.*MOCK-SO-1/);
  assert.match(get('lesson').className,/ok/);
  assert.equal(get('blocker').hidden,true);
});
