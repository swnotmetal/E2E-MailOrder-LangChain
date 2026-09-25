import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { type Order } from './erp.js';

async function csv(name:string) {
  const text=await readFile(new URL(`../fixtures/erp-spareparts-demo/${name}`,import.meta.url),'utf8');
  if(text.includes('"')) throw Error(`CSV_QUOTES_UNSUPPORTED:${name}`); // ponytail: controlled fixtures have no quoted commas; add a parser if that changes.
  const [header,...lines]=text.trim().replace(/^\uFEFF/,'').split(/\r?\n/);
  const fields=header.split(',');
  return lines.map((line,index)=>{
    const values=line.split(',');
    if(values.length!==fields.length) throw Error(`INVALID_CSV_ROW:${name}:${index+2}`);
    return Object.fromEntries(fields.map((field,i)=>[field,values[i]]));
  });
}

export async function mockERP(port=0) {
  const [itemRows,binRows,customerRows,addressRows,salesRows]=await Promise.all([
    csv('items.csv'),csv('inventory_bins.csv'),csv('customers.csv'),csv('addresses.csv'),csv('sales_order_lines.csv')
  ]);
  const customers=customerRows.map(row=>({name:row.Customer_ID,customer_name:row.Customer_Name,customer_type:row.Customer_Type,
    contact_name:row.Contact_Name,contact_email:row.Contact_Email,territory:row.Territory,disabled:0}));
  const items=itemRows.map(row=>({name:row.Item_Code,item_name:row.Item_Name,stock_uom:row.Stock_UOM,
    is_stock_item:Number(row.Is_Stock_Item),is_sales_item:1,disabled:0,standard_rate:Number(row.Selling_Price_EUR)}));
  const bins=binRows.map(row=>({item_code:row.Item_Code,warehouse:row.Warehouse,actual_qty:Number(row.Actual_Qty),
    projected_qty:Number(row.Projected_Qty),reserved_qty:Number(row.Reserved_Qty)}));
  const addresses=addressRows.map(row=>({name:row.Address_ID,customer_id:row.Customer_ID,address_type:row.Address_Type,
    address_line1:row.Address_Line1,address_line2:'',city:row.City,pincode:row.Postal_Code,country:row.Country,disabled:0}));
  const groupedSales=new Map<string,typeof salesRows>();
  for(const row of salesRows) groupedSales.set(row.SO_Number,[...(groupedSales.get(row.SO_Number)??[]),row]);
  const historicalOrders=[...groupedSales].map(([name,lines])=>{const first=lines[0];return {name,customer:first.Customer_ID,
    po_no:first.Customer_PO,shipping_address_name:first.Shipping_Address_ID,transaction_date:first.Order_Date,delivery_date:first.Delivery_Date,
    custom_integration_key:first.Integration_Key,custom_review_digest:`fixture:${first.Integration_Key}`,docstatus:first.Status==='Draft'?0:1,
    items:lines.map(line=>({item_code:line.Item_Code,qty:Number(line.Qty_Sold),uom:'Nos',rate:Number(line.Unit_Price_EUR)}))};});
  const orders:Order[]=[]; let posts=0; let timeoutAfterCommit=false; let getFails=false;
  const reset=()=>{orders.length=0;posts=0;timeoutAfterCommit=false;getFails=false;};
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url!,'http://localhost');
    res.setHeader('Content-Type','application/json');
    if(req.method==='GET' && url.pathname==='/__mock/status') {res.end(JSON.stringify({posts,orders}));return;}
    if(req.method==='POST' && url.pathname==='/__mock/reset') {reset();res.end(JSON.stringify({reset:true}));return;}
    const doc=decodeURIComponent(url.pathname.split('/').pop()!);
    if(getFails && req.method==='GET') {res.writeHead(503).end('{}');return;}
    if(req.method==='POST' && doc==='Sales Order') {
      let raw='';for await(const chunk of req) raw+=chunk;
      const body=JSON.parse(raw);
      if([...historicalOrders,...orders].some(o=>o.custom_integration_key===body.custom_integration_key)) {res.writeHead(409).end('{}');return;}
      const order={...body,name:`MOCK-SO-${++posts}`,docstatus:0};orders.push(order);
      if(timeoutAfterCommit) {
        timeoutAfterCommit=false;
        const timer=setTimeout(()=>res.end(JSON.stringify({data:order})),1500);
        res.on('close',()=>clearTimeout(timer));return;
      }
      res.end(JSON.stringify({data:order}));return;
    }
    const data:Record<string,unknown[]>={
      Customer:customers,Item:items,Bin:bins,Address:addresses,'Sales Order':[...orders,...historicalOrders]
    };
    let rows=data[doc]??[];
    const filters=JSON.parse(url.searchParams.get('filters')??'[]') as unknown[][];
    const orFilters=JSON.parse(url.searchParams.get('or_filters')??'[]') as unknown[][];
    const matches=(row:unknown,filter:unknown[])=>{
      if(filter.length===3) {const [key,op,value]=filter;const actual=(row as Record<string,unknown>)[String(key)];
        if(op==='=') return actual===value;
        if(op==='like') return String(actual??'').toLowerCase().includes(String(value).replaceAll('%','').toLowerCase());
      }
      if(doc==='Address'&&filter.length===4&&filter[0]==='Dynamic Link'&&filter[2]==='=') {
        return filter[1]!=='link_name'||(row as {customer_id?:string}).customer_id===filter[3];
      }
      return true;
    };
    rows=rows.filter(row=>filters.every(filter=>matches(row,filter))&&(!orFilters.length||orFilters.some(filter=>matches(row,filter))));
    const start=Number(url.searchParams.get('limit_start')??0),length=Number(url.searchParams.get('limit_page_length')??20);
    const fields=JSON.parse(url.searchParams.get('fields')??'[]') as string[];
    rows=rows.slice(start,start+length).map(row=>fields.length?Object.fromEntries(fields.map(field=>[field,(row as Record<string,unknown>)[field]])):row);
    res.end(JSON.stringify({data:rows}));
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,orders,get posts(){return posts;},
    timeout(){timeoutAfterCommit=true;},failReads(on:boolean){getFails=on;},reset,
    close:()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()))};
}
