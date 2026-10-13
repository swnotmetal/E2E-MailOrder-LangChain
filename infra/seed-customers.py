# Seeds the fictional customers referenced by test/mail-tests.txt (they are NOT in the CSV
# catalogue) plus their shipping addresses, so a purchase order from a "new" customer can be
# matched and approved. Run inside the backend container via bench console, like the other seeds.
import frappe

if frappe.local.site != 'frontend':
    raise RuntimeError('This seed only supports the dedicated frontend demo site')
frappe.set_user('Administrator')
frappe.local.lang = 'en'

def ensure_customer(name):
    if frappe.db.exists('Customer', name):
        return frappe.get_doc('Customer', name)
    return frappe.get_doc(dict(doctype='Customer', customer_name=name, customer_type='Company',
        customer_group='Demo Customers', territory='Demo Finland', default_currency='EUR',
        default_price_list='Nordic Demo EUR')).insert(ignore_permissions=True)

def ensure_address(customer, title, line1, city, state, pincode, country):
    if frappe.db.exists('Address', {'address_title': title}):
        return
    frappe.get_doc(dict(doctype='Address', address_title=title, address_type='Shipping',
        address_line1=line1, city=city, state=state, pincode=pincode, country=country,
        is_shipping_address=1, links=[dict(link_doctype='Customer', link_name=customer.name)])).insert(ignore_permissions=True)

for name, title, line1, city, state, pincode, country in [
    ('OZ Hardware Logistics', 'OZ Hardware Logistics Ship', '45 George Street', 'Sydney', 'NSW', '2000', 'Australia'),
    ('Tokyo Machinery Corp.', 'Tokyo Machinery Ship', '2-Chome Minatomirai, Nishi Ward', 'Yokohama', 'Kanagawa', '220-0012', 'Japan'),
    ('Automotive Solutions SA', 'Automotive Solutions Ship', 'Av. Constitución 456', 'Monterrey', 'Nuevo León', '64000', 'Mexico'),
]:
    c = ensure_customer(name)
    ensure_address(c, title, line1, city, state, pincode, country)
frappe.db.commit()
print('Customers seeded:', frappe.db.count('Customer'), 'total;', frappe.db.count('Address'), 'addresses')
