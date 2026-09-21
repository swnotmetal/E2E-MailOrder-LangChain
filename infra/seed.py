# Run only inside the dedicated fictional ERPNext frontend site via bench console.
import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

if frappe.local.site != 'frontend':
    raise RuntimeError('This seed only supports the dedicated frontend demo site')
frappe.set_user('Administrator')
frappe.local.lang = 'en'

def ensure(doctype, name, values):
    if frappe.db.exists(doctype, name):
        return frappe.get_doc(doctype, name)
    return frappe.get_doc(dict(doctype=doctype, **values)).insert()

ensure('Warehouse Type', 'Transit', dict(name='Transit'))
company = ensure('Company', 'Nordic Parts Demo', dict(company_name='Nordic Parts Demo', abbr='NPD', default_currency='EUR', country='Finland', create_chart_of_accounts_based_on='Standard Template', chart_of_accounts='Standard'))
ensure('Price List', 'Nordic Demo EUR', dict(price_list_name='Nordic Demo EUR', selling=1, enabled=1, currency='EUR'))
ensure('Customer Group', 'All Customer Groups', dict(customer_group_name='All Customer Groups', is_group=1))
ensure('Territory', 'All Territories', dict(territory_name='All Territories', is_group=1))
ensure('Customer Group', 'Demo Customers', dict(customer_group_name='Demo Customers', is_group=0, parent_customer_group='All Customer Groups'))
ensure('Territory', 'Demo Finland', dict(territory_name='Demo Finland', is_group=0, parent_territory='All Territories'))
customer = ensure('Customer', 'Acme Workshop', dict(customer_name='Acme Workshop', customer_type='Company', customer_group='Demo Customers', territory='Demo Finland', default_currency='EUR', default_price_list='Nordic Demo EUR'))
ensure('Address Template', 'Finland', dict(country='Finland', is_default=1, template='<div>{{ address_line1 }}<br>{{ city }} {{ pincode }}<br>{{ country }}</div>'))
if not frappe.db.exists('Address', {'address_title':'Acme Workshop Demo'}):
    frappe.get_doc(dict(doctype='Address', address_title='Acme Workshop Demo', address_type='Shipping',address_line1='10 Test Road',city='Helsinki',pincode='00100',country='Finland',is_shipping_address=1,links=[dict(link_doctype='Customer',link_name=customer.name)])).insert()
ensure('UOM', 'Nos', dict(uom_name='Nos'))
ensure('Item Group', 'All Item Groups', dict(item_group_name='All Item Groups', is_group=1))
ensure('Item Group', 'Demo Parts', dict(item_group_name='Demo Parts', is_group=0, parent_item_group='All Item Groups'))
for code, label, rate in [('FILTER-A10','Filter A10',12),('FILTER-A20','Filter A20',18)]:
    ensure('Item',code,dict(item_code=code,item_name=label,item_group='Demo Parts',stock_uom='Nos',is_stock_item=0,is_sales_item=1))
    if not frappe.db.exists('Item Price',{'item_code':code,'price_list':'Nordic Demo EUR'}):
        frappe.get_doc(dict(doctype='Item Price',item_code=code,price_list='Nordic Demo EUR',price_list_rate=rate)).insert()
create_custom_fields({'Sales Order':[
    dict(fieldname='custom_integration_key',label='Order Review Integration Key',fieldtype='Data',unique=1,no_copy=1,read_only=1,insert_after='po_no'),
    dict(fieldname='custom_review_digest',label='Order Review Content Digest',fieldtype='Data',no_copy=1,read_only=1,insert_after='custom_integration_key')
]},update=True)
# A non-admin API user; ERP roles perform server-side permissions checks.
user=ensure('User','order-review@example.invalid',dict(email='order-review@example.invalid',first_name='Order Review Demo',send_welcome_email=0,user_type='System User',roles=[dict(role='Sales User')]))
if not user.api_key:
    user.api_key=frappe.generate_hash(length=15)
    user.api_secret=frappe.generate_hash(length=32)
    user.save()
frappe.db.commit()
from pathlib import Path
# Secret is copied to ignored .env by the startup script, never printed.
Path('/tmp/order-review.env').write_text('ERP_URL=http://127.0.0.1:8080\nERP_COMPANY=Nordic Parts Demo\nERP_TOKEN='+user.api_key+':'+user.get_password('api_secret')+'\n')
print('Fictional ERP seed ready; API credential written to private temporary file.')







