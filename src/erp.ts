import { type Customer, type Item, type Address, type Draft, digest, orderKey, normalize } from './domain.js';
export type ERP = Pick<FrappeERP, 'findCustomers'|'findItems'|'inventory'|'addresses'|'duplicates'|'createDraft'|'suggestReply'|'createCustomer'|'reviewState'>;
export type Order = {name:string; custom_integration_key?:string; custom_review_digest?:string; docstatus:number; po_no?:string};
export type Inventory = {itemCode:string; itemName:string; stockTracked:boolean; totalActualQty:number|null; warehouses:{warehouse:string;actualQty:number;projectedQty:number;reservedQty:number}[]};

export class FrappeERP {
  constructor(readonly base:string, private auth:string, readonly company:string, readonly timeoutMs=10000) {
    const url = new URL(base);
    if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw Error('LOCAL_ERP_ONLY');
  }
  async request<T>(path:string, body?:unknown, method:'POST'|'PUT'='POST'): Promise<T> {
    const res = await fetch(this.base + path, {method:body?method:'GET', redirect:'error',
      headers:{Authorization:this.auth,'Content-Type':'application/json'},
      body:body?JSON.stringify(body):undefined, signal:AbortSignal.timeout(this.timeoutMs)});
    if (!res.ok) throw Error(`ERP_HTTP_${res.status}`) // Do not print server internals or credentials.
    return (await res.json() as {data:T}).data;
  }
  async list<T>(doctype:string, fields:string[], filters:unknown[]=[],orFilters:unknown[]=[]):Promise<T[]> {
    const rows:T[]=[];
    for(let offset=0; offset<1000; offset+=100) {
      const query = new URLSearchParams({fields:JSON.stringify(fields),filters:JSON.stringify(filters),limit_page_length:'100',limit_start:String(offset)});
      if(orFilters.length) query.set('or_filters',JSON.stringify(orFilters));
      const page = await this.request<T[]>(`/api/resource/${encodeURIComponent(doctype)}?${query}`);
      rows.push(...page); if(page.length<100) return rows;
    }
    throw Error('CATALOG_LIMIT: narrow the query before using a larger ERP');
  }
  customers() {return this.list<Customer>('Customer',['name','customer_name'],[['disabled','=',0]]);}
  items() {return this.list<Item>('Item',['name','item_name','stock_uom','disabled'],[['disabled','=',0],['is_sales_item','=',1]]);}
  findCustomers(text:string) {
    return text.trim()?this.list<Customer>('Customer',['name','customer_name'],[['disabled','=',0]],
      [['name','=',text],['customer_name','=',text]]):Promise.resolve([]);
  }
  findItems(text:string) {
    if(text.length>500) throw Error('CATALOG_QUERY_LIMIT');
    const tokens=[...new Set(normalize(text).match(/[\p{L}\p{N}]+/gu)??[])].filter(token=>token.length>1).slice(0,8);
    const searches=[...new Set(tokens)].flatMap(value=>[['name','like',`%${value}%`],['item_name','like',`%${value}%`]]);
    return searches.length?this.list<Item>('Item',['name','item_name','stock_uom','disabled'],
      [['disabled','=',0],['is_sales_item','=',1]],searches):Promise.resolve([]);
  }
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
    const rows = await this.list<{name:string;address_line1:string;address_line2:string;city:string;state:string;country:string;pincode:string}>('Address',
      ['name','address_line1','address_line2','city','state','country','pincode'],
      [['Dynamic Link','link_doctype','=','Customer'],['Dynamic Link','link_name','=',customer],['disabled','=',0]]);
    return rows.map(a=>({name:a.name,text:[a.address_line1,a.address_line2,a.city,a.state,a.pincode,a.country].filter(Boolean).join(', ')}));
  }
  async duplicates(d:Draft) {
    const rows=await this.list<Order>('Sales Order',['name','docstatus','po_no','custom_integration_key','custom_review_digest'],[['customer','=',d.customer]]);
    return rows.filter(o=>normalize(o.po_no??'')===normalize(d.po));
  }
  async byKey(key:string) {return this.list<Order>('Sales Order',['name','docstatus','custom_integration_key','custom_review_digest'],[['custom_integration_key','=',key]]);}
  // The ERP is the review surface. A human submits or cancels the draft in ERPNext, and this is
  // how the workflow discovers what they decided. Strictly read-only: it never edits a document, and
  // `modified_by` / `modified` are the ERP's own record of who acted and when, so the audit entry
  // is authored by ERPNext rather than asserted by this application.
  async reviewState(key:string):Promise<{name:string;docstatus:number;digest:string;actor:string;modified:string}|null> {
    const rows=await this.list<{name:string;docstatus:number;custom_review_digest?:string;modified_by?:string;modified?:string}>(
      'Sales Order',['name','docstatus','custom_review_digest','modified_by','modified'],[['custom_integration_key','=',key]]);
    const row=rows[0];
    if(!row) return null;
    return {name:row.name,docstatus:Number(row.docstatus),digest:row.custom_review_digest??'',actor:row.modified_by??'',modified:row.modified??''};
  }
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
  // A suggested reply is filed as a ToDo: the ERP's own "a human must act on this" object, so it
  // shows up in the work queue next to the customer. It is NOT a Communication: that is email
  // history, and filing an unsent draft there would imply correspondence that never happened.
  // A received mail IS a Communication: correspondence that really happened. This is the exact
  // opposite of an unsent draft, which must never be filed here because it would imply an exchange
  // that never took place. Recording it is what puts the original message on the customer's
  // timeline, next to the work item that refers to it.
  //
  // Frappe restricts the Communication *list* to the human user who owns the correspondence, so
  // this account can create one and read it back by name but cannot enumerate them. Deduplication
  // therefore never lists Communications: the work item holds the reference and is what we look up.
  private async fileReceivedMail(m:{subject:string;sender:string;senderName?:string;text:string;customer?:string}):Promise<{name:string}> {
    const escape=(text:string)=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return this.request<{name:string}>('/api/resource/Communication', {
      doctype:'Communication',communication_type:'Communication',communication_medium:'Email',sent_or_received:'Received',
      sender:m.sender,...(m.senderName?{sender_full_name:m.senderName}:{}),
      subject:m.subject||'(no subject)',
      content:`<p>${escape(m.text).replace(/\n/g,'<br>')}</p>`,text_content:m.text,
      ...(m.customer?{reference_doctype:'Customer',reference_name:m.customer}:{})
    });
  }
  async suggestReply(s:{summary:string;draft:string;mail:string;revision:string;customer?:string;label?:string;
    communication?:{subject:string;sender:string;senderName?:string;text:string}}):Promise<{name:string;communication:string}> {
    // The mail digest is the suggestion's identity, so re-ingesting the same message reconciles to
    // the work item that already exists instead of filing a second one. The review revision is
    // deliberately NOT used here: it also covers the model prose, which varies between runs.
    const existing=await this.list<{name:string;status:string;description:string;reference_type?:string;reference_name?:string}>(
      'ToDo',['name','status','description','reference_type','reference_name'],[['description','like',`%${s.mail}%`]]);
    // A handoff is not a suggested reply — it is work a human must do — so callers pass label:''.
    const label=s.label===undefined?'Suggested reply (not sent):':s.label;
    const description=[s.summary,...(label?['',label]:[]),'',s.draft,'',`-- mail ${s.mail}`,`-- review revision ${s.revision}`].join('\n');
    if(existing.length) {
      const current=existing[0];
      let communication=current.reference_type==='Communication'?(current.reference_name??''):'';
      // The work item is this application's own proposal, so a re-ingest refreshes it to the current
      // judgement instead of leaving a stale reason behind. Only while it is still Open: once a
      // human has worked it the description may hold their notes, which must not be overwritten.
      const patch:Record<string,string>={};
      if(current.status==='Open' && current.description!==description) patch.description=description;
      if(!communication && s.communication) {
        communication=(await this.fileReceivedMail({...s.communication,customer:s.customer})).name;
        patch.reference_type='Communication';patch.reference_name=communication;
      }
      if(Object.keys(patch).length) await this.request(`/api/resource/ToDo/${encodeURIComponent(current.name)}`,patch,'PUT');
      return {name:current.name,communication};
    }
    const communication=s.communication?(await this.fileReceivedMail({...s.communication,customer:s.customer})).name:'';
    const created=await this.request<{name:string}>('/api/resource/ToDo', {
      doctype:'ToDo',status:'Open',priority:'Medium',description,
      ...(communication?{reference_type:'Communication',reference_name:communication}
        :s.customer?{reference_type:'Customer',reference_name:s.customer}:{})
    });
    return {name:created.name,communication};
  }
  // A confirmed new customer is written once and then matched forever after. Like a Sales Order,
  // this only happens after a human approves the proposal in the review — the model never creates
  // customers on its own.
  //
  // ERPNext's Address mandates BOTH `city` and `country`, but this app carries a single free-text
  // address line (it does not parse the mail into city/state/country). It therefore stores the
  // whole line as the city and the operating company's own country as the country. That is an
  // explicit, reviewable assumption, not a parsed address: an international customer must be
  // corrected in the ERP afterwards. `country` must be a real Country link — an empty string is
  // rejected with MandatoryError, so a non-empty value is required.
  private async companyCountry():Promise<string> {
    const rows=await this.list<{country:string}>('Company',['country'],[['name','=',this.company]]).catch(()=>[]);
    return rows[0]?.country||'Finland';
  }
  private async createAddress(customerName:string,addressText:string):Promise<string> {
    const created=await this.request<{name:string}>('/api/resource/Address', {
      doctype:'Address',address_title:`${customerName} Ship`,address_type:'Shipping',address_line1:addressText,
      city:addressText,country:await this.companyCountry(),is_shipping_address:1,
      links:[{link_doctype:'Customer',link_name:customerName}]
    });
    return created.name;
  }
  async createCustomer(c:{name:string;address?:string}):Promise<{name:string;address?:string}> {
    const existing=await this.findCustomers(c.name);
    if(existing.length) {
      const name=existing[0].name;
      const linked=await this.addresses(name);
      // Self-heal: a previous attempt may have created the customer and then failed on the address,
      // leaving the pair half-written. Re-confirming completes the missing address instead of
      // dead-ending on a customer that can never receive one.
      if(c.address && !linked.length) return {name,address:await this.createAddress(name,c.address)};
      return {name,address:linked[0]?.name};
    }
    const customer=await this.request<{name:string}>('/api/resource/Customer', {
      doctype:'Customer',customer_name:c.name,customer_type:'Company',customer_group:'Demo Customers',
      territory:'Demo Finland',default_currency:'EUR',default_price_list:'Nordic Demo EUR'
    });
    const address=c.address?await this.createAddress(customer.name,c.address):undefined;
    return {name:customer.name,address};
  }
}

