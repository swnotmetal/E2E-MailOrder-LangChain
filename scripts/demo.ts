import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mockERP } from '../test/mock-erp.js';

const mock=await mockERP();
const dir=resolve('data',`mock-demo-${Date.now()}`);
await mkdir(dir,{recursive:true});
function cli(args:string[]) {
  return new Promise<any>((resolve,reject)=>{
    const child=spawn(process.execPath,['--import','tsx','src/cli.ts',...args],{env:{...process.env,ERP_URL:mock.url,ERP_TOKEN:'test:test',ORDER_DATA_DIR:dir,ERP_ENV_FILE:''},stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);
    child.on('error',reject);child.on('close',code=>code===0?resolve(out.trim()?JSON.parse(out):null):reject(Error(err)));
  });
}
try {
  const imported=await cli(['import','fixtures/01-clean.eml','fixtures/01-clean.pdf']);
  const file=resolve(dir,'review.json');await cli(['review',imported.id,file]);
  const review=JSON.parse(await readFile(file,'utf8'));review.action='approve';review.reason='Development-only automated approval of fictional fixture';
  await writeFile(file,JSON.stringify(review,null,2));
  const created=await cli(['decide',imported.id,file]);
  const repeated=await cli(['decide',imported.id,file]);
  if(created.status!=='created'||mock.posts!==1||created.order!==repeated.order) throw Error('Demo invariant failed');
  const report={mode:'HTTP MOCK - NOT REAL ERP ACCEPTANCE',id:imported.id,order:created.order,posts:mock.posts,processes:4,persistence:'SQLite',modelCalls:0,modelCostUSD:0,artifacts:dir};
  await writeFile(resolve(dir,'result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally {await mock.close();}
