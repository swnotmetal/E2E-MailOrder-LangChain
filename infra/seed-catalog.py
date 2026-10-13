# Seeds the full fictional item catalogue from data/erp_spareparts_db/items.csv into the
# dedicated demo ERP. Run inside the backend container via bench console, like infra/seed.py.
# Items are seeded as NON-stock: the demo has no real Warehouses/Bins, so claiming stock would
# fabricate an availability the application then reports as fact (it reads Bin, not the CSV).
import frappe, csv, os

if frappe.local.site != 'frontend':
    raise RuntimeError('This seed only supports the dedicated frontend demo site')
frappe.set_user('Administrator')
frappe.local.lang = 'en'

def ensure(doctype, name, values):
    if frappe.db.exists(doctype, name):
        return
    frappe.get_doc(dict(doctype=doctype, **values)).insert(ignore_permissions=True)

base = '/tmp/erp_spareparts_db'
ensure('Item Group', 'Demo Parts', dict(item_group_name='Demo Parts', is_group=0, parent_item_group='All Item Groups'))
created = 0
with open(os.path.join(base, 'items.csv'), encoding='utf-8-sig') as f:
    for row in csv.DictReader(f):
        code = row['Item_Code'].strip()
        if frappe.db.exists('Item', code):
            continue
        ensure('Item', code, dict(item_code=code, item_name=row['Item_Name'].strip(),
            item_group='Demo Parts', stock_uom='Nos', is_stock_item=0, is_sales_item=1))
        if not frappe.db.exists('Item Price', {'item_code': code, 'price_list': 'Nordic Demo EUR'}):
            frappe.get_doc(dict(doctype='Item Price', item_code=code, price_list='Nordic Demo EUR',
                price_list_rate=float(row['Selling_Price_EUR']))).insert(ignore_permissions=True)
        created += 1
frappe.db.commit()
print(f'Catalog seeded: {created} new items; total items now {frappe.db.count("Item")}')
