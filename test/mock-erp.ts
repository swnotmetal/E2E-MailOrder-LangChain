import { createServer } from 'node:http';
import { type Order } from '../src/erp.js';
export async function mockERP() {
  const orders:Order[]=[]; let posts=0; let timeoutAfterCommit=false; let getFails=false;
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url!,'http://localhost');
    const doc=decodeURIComponent(url.pathname.split('/').pop()!);
    res.setHeader('Content-Type','application/json');
    if(getFails && req.method==='GET') {res.writeHead(503).end('{}');return;}
    if(req.method==='POST' && doc==='Sales Order') {
      let raw='';for await(const chunk of req) raw+=chunk;
      const body=JSON.parse(raw);
      if(orders.some(o=>o.custom_integration_key===body.custom_integration_key)) {res.writeHead(409).end('{}');return;}
      const order={...body,name:`MOCK-SO-${++posts}`,docstatus:0};orders.push(order);
      if(timeoutAfterCommit) {
        timeoutAfterCommit=false;
        const timer=setTimeout(()=>res.end(JSON.stringify({data:order})),1500);
        res.on('close',()=>clearTimeout(timer));return;
      }
      res.end(JSON.stringify({data:order}));return;
    }
    const data:Record<string,unknown[]>={
      Customer:[{name:'ACME',customer_name:'Acme Workshop'}],
      Item:[{name:'FILTER-A10',item_name:'Filter A10',stock_uom:'Nos'},{name:'FILTER-A20',item_name:'Filter A20',stock_uom:'Nos'}],
      Address:[{name:'ACME-Shipping',address_line1:'10 Test Road',city:'Helsinki',pincode:'00100',country:'Finland'}],
      'Sales Order':orders
    };
    let rows=data[doc]??[];
    if(doc==='Sales Order') {
      const filters=JSON.parse(url.searchParams.get('filters')??'[]') as [string,string,unknown][];
      rows=rows.filter(row=>filters.every(([key,,value])=>(row as Record<string,unknown>)[key]===value));
    }
    res.end(JSON.stringify({data:rows}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  return {url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,orders,get posts(){return posts;},
    timeout(){timeoutAfterCommit=true;},failReads(on:boolean){getFails=on;},
    close:()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()))};
}
