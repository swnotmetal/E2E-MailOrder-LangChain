import { type Customer, type Item, type Address, type Draft, digest, orderKey, normalize } from './domain.js';
export type ERP = Pick<FrappeERP, 'customers'|'items'|'inventory'|'addresses'|'duplicates'|'createDraft'>;
export type Order = {name:string; custom_integration_key?:string; custom_review_digest?:string; docstatus:number; po_no?:string};
export type Inventory = {itemCode:string; itemName:string; stockTracked:boolean; totalActualQty:number|null; warehouses:{warehouse:string;actualQty:number;projectedQty:number;reservedQty:number}[]};

export class FrappeERP {
  constructor(readonly base:string, private auth:string, readonly company:string, readonly timeoutMs=10000) {
    const url = new URL(base);
    if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw Error('LOCAL_ERP_ONLY');
  }
  async request<T>(path:string, body?:unknown): Promise<T> {
    const res = await fetch(this.base + path, {method:body?'POST':'GET', redirect:'error',
      headers:{Authorization:this.auth,'Content-Type':'application/json'},
      body:body?JSON.stringify(body):undefined, signal:AbortSignal.timeout(this.timeoutMs)});
    if (!res.ok) throw Error(`ERP_HTTP_${res.status}`) // Do not print server internals or credentials.
    return (await res.json() as {data:T}).data;
  }
  async list<T>(doctype:string, fields:string[], filters:unknown[]=[]):Promise<T[]> {
    const rows:T[]=[];
    for(let offset=0; offset<1000; offset+=100) {
      const query = new URLSearchParams({fields:JSON.stringify(fields),filters:JSON.stringify(filters),limit_page_length:'100',limit_start:String(offset)});
      const page = await this.request<T[]>(`/api/resource/${encodeURIComponent(doctype)}?${query}`);
      rows.push(...page); if(page.length<100) return rows;
    }
    throw Error('CATALOG_LIMIT: narrow the query before using a larger ERP');
  }
  customers() {return this.list<Customer>('Customer',['name','customer_name'],[['disabled','=',0]]);}
  items() {return this.list<Item>('Item',['name','item_name','stock_uom','disabled'],[['disabled','=',0],['is_sales_item','=',1]]);}
  async inventory(itemCode:string):Promise<Inventory> {
    const items=await this.list<Item&{is_stock_item:number}>('Item',['name','item_name','is_stock_item'],[['name','=',itemCode],['disabled','=',0]]);
    if(items.length!==1) throw Error('ITEM_NOT_FOUND');
    const item=items[0];
    if(!item.is_stock_item) return {itemCode:item.name,itemName:item.item_name,stockTracked:false,totalActualQty:null,warehouses:[]};
    const bins=await this.list<{warehouse:string;actual_qty:number;projected_qty:number;reserved_qty:number}>('Bin',
      ['warehouse','actual_qty','projected_qty','reserved_qty'],[['item_code','=',itemCode]]);
    const warehouses=bins.map(b=>({warehouse:b.warehouse,actualQty:Number(b.actual_qty),projectedQty:Number(b.projected_qty),reservedQty:Number(b.reserved_qty)}));
    return {itemCode:item.name,itemName:item.item_name,stockTracked:true,
      totalActualQty:warehouses.reduce((sum,row)=>sum+row.actualQty,0),warehouses};
  }
  async addresses(customer:string):Promise<Address[]> {
    const rows = await this.list<{name:string;address_line1:string;address_line2:string;city:string;country:string;pincode:string}>('Address',
      ['name','address_line1','address_line2','city','country','pincode'],
      [['Dynamic Link','link_doctype','=','Customer'],['Dynamic Link','link_name','=',customer],['disabled','=',0]]);
    return rows.map(a=>({name:a.name,text:[a.address_line1,a.address_line2,a.city,a.pincode,a.country].filter(Boolean).join(', ')}));
  }
  async duplicates(d:Draft) {
    const rows=await this.list<Order>('Sales Order',['name','docstatus','po_no','custom_integration_key','custom_review_digest'],[['customer','=',d.customer]]);
    return rows.filter(o=>normalize(o.po_no??'')===normalize(d.po));
  }
  async byKey(key:string) {return this.list<Order>('Sales Order',['name','docstatus','custom_integration_key','custom_review_digest'],[['custom_integration_key','=',key]]);}
  async createDraft(d:Draft):Promise<Order> {
    const key=orderKey(d), hash=digest(d);
    const reconcile = async () => {
      const found = await this.byKey(key);
      if(found.length) {
        if(found[0].custom_review_digest!==hash || found[0].docstatus!==0) throw Error('DUPLICATE_CHANGED_OR_NOT_DRAFT');
        return found[0];
      }
    };
    const existing = await reconcile(); if(existing) return existing;
    if((await this.duplicates(d)).length) throw Error('DUPLICATE_PO');
    try {
      return await this.request<Order>('/api/resource/Sales%20Order', {
        doctype:'Sales Order',docstatus:0,company:this.company,customer:d.customer,po_no:d.po,order_type:'Sales',selling_price_list:'Nordic Demo EUR',currency:'EUR',conversion_rate:1,
        transaction_date:new Date().toISOString().slice(0,10),delivery_date:d.date,shipping_address_name:d.address,
        custom_integration_key:key,custom_review_digest:hash,
        items:d.lines.map(l=>({item_code:l.item,qty:Number(l.quantity),uom:l.unit,delivery_date:d.date}))
      });
    } catch(error) {
      // A timeout might mean the write committed. Always reconcile before any later retry.
      const found=await reconcile(); if(found) return found;
      throw error;
    }
  }
}

