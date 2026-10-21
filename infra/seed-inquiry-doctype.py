# Creates the `Inquiry` DocType: the human review surface for inbound sales mail.
#
# Why a custom DocType at all: ERPNext has no place for "an email that could not become an order".
# A ToDo has no review semantics, no permission split and cannot send mail, so it cannot be the
# queue. Frappe's native pattern is a DocType with a Status field, fed by an Email Account's
# `Append To`, reviewed through a Workflow.
#
# Run inside the backend container. `bench console` already has the site initialised, so the
# script connects only when it is run directly with a bare interpreter.
#   docker cp infra/seed-inquiry-doctype.py order-review-demo-backend-1:/tmp/seed.py
#   docker exec order-review-demo-backend-1 bash -lc \
#     "cd /home/frappe/frappe-bench && echo \"exec(open('/tmp/seed.py').read())\" | bench --site frontend console"
import frappe

SITE = "frontend"
SITES_PATH = "/home/frappe/frappe-bench/sites"

STATUSES = ["Pending Review", "Qualified", "Rejected", "Screened Out"]
ACTIONS = [("Qualify", "Qualified"), ("Reject", "Rejected"), ("Screen", "Screened Out")]

_standalone = not getattr(frappe.local, "site", None)
if _standalone:
    frappe.init(site=SITE, sites_path=SITES_PATH)
    frappe.connect()
try:
    if frappe.db.exists("DocType", "Inquiry"):
        print("DocType Inquiry already exists")
    else:
        frappe.get_doc({
            "doctype": "DocType",
            "name": "Inquiry",
            "module": "Custom",
            "custom": 1,
            "autoname": "INQ-.#####",
            "naming_rule": "Expression (old style)",
            "title_field": "subject",
            "search_fields": "subject,sender",
            "fields": [
                {"fieldname": "subject", "label": "Subject", "fieldtype": "Data", "reqd": 1, "in_list_view": 1},
                {"fieldname": "sender", "label": "Sender", "fieldtype": "Data", "in_list_view": 1},
                {"fieldname": "customer", "label": "Customer", "fieldtype": "Link", "options": "Customer"},
                {"fieldname": "purchase_order", "label": "Customer PO", "fieldtype": "Data"},
                {"fieldname": "body", "label": "Body", "fieldtype": "Text Editor"},
                # Frappe records the mail it came from here; it is what makes the record traceable
                # back to a single message instead of a timestamp.
                {"fieldname": "source_message_id", "label": "Source Message ID",
                 "fieldtype": "Data", "unique": 1, "read_only": 1},
            ],
            "permissions": [
                {"role": "System Manager", "read": 1, "write": 1, "create": 1, "delete": 1, "report": 1, "export": 1, "share": 1},
                {"role": "Sales User", "read": 1, "write": 1, "create": 1, "report": 1},
            ],
        }).insert(ignore_permissions=True)
        print("DocType Inquiry created")

    # Per-line ERP resolution: what the reviewer needs to see next to the customer's wording.
    if not frappe.db.exists("DocType", "Inquiry Line"):
        frappe.get_doc({
            "doctype": "DocType", "name": "Inquiry Line", "module": "Custom", "custom": 1, "istable": 1,
            "fields": [
                {"fieldname": "description", "label": "As written by the customer", "fieldtype": "Data", "in_list_view": 1},
                {"fieldname": "item", "label": "ERP item", "fieldtype": "Link", "options": "Item", "in_list_view": 1},
                {"fieldname": "quantity", "label": "Qty", "fieldtype": "Data", "in_list_view": 1},
                {"fieldname": "uom", "label": "UOM", "fieldtype": "Data"},
                {"fieldname": "stock", "label": "Recorded stock", "fieldtype": "Float", "in_list_view": 1},
                {"fieldname": "status", "label": "Resolution", "fieldtype": "Data", "in_list_view": 1},
            ],
            "permissions": [],
        }).insert(ignore_permissions=True)
        print("DocType Inquiry Line created")

    # Fields added after the DocType already existed; appended in place so a seeded site picks
    # them up instead of needing the table rebuilt.
    LATER_FIELDS = [
        {"fieldname": "lead", "label": "Lead", "fieldtype": "Link", "options": "Lead"},
        {"fieldname": "suggested_reply", "label": "Suggested reply (not sent)", "fieldtype": "Text Editor"},
        {"fieldname": "lines", "label": "Resolved lines", "fieldtype": "Table", "options": "Inquiry Line"},
        {"fieldname": "quotation", "label": "Draft quotation", "fieldtype": "Link", "options": "Quotation", "read_only": 1},
        {"fieldname": "screening", "label": "Pre-screen", "fieldtype": "Data", "read_only": 1},
    ]
    inquiry_dt = frappe.get_doc("DocType", "Inquiry")
    have = {f.fieldname for f in inquiry_dt.fields}
    missing = [f for f in LATER_FIELDS if f["fieldname"] not in have]
    for field in missing:
        inquiry_dt.append("fields", field)
    # `status` duplicated the workflow state and was removed: one state field, the Workflow's.
    stale = [row for row in inquiry_dt.fields if row.fieldname == "status"]
    for row in stale:
        inquiry_dt.remove(row)
    if missing or stale:
        inquiry_dt.save()
        print("DocType Inquiry updated:",
              f"added {[f['fieldname'] for f in missing]}", f"removed status x{len(stale)}")

    for state in STATUSES:
        if not frappe.db.exists("Workflow State", state):
            frappe.get_doc({"doctype": "Workflow State", "workflow_state_name": state}).insert(ignore_permissions=True)
    for action, _next_state in ACTIONS:
        if not frappe.db.exists("Workflow Action Master", action):
            frappe.get_doc({"doctype": "Workflow Action Master", "workflow_action_name": action}).insert(ignore_permissions=True)

    workflow_name = frappe.db.get_value("Workflow", {"document_type": "Inquiry"}, "name")
    if workflow_name:
        # States added after the workflow was first created (e.g. "Screened Out") must be appended,
        # otherwise Frappe rejects a document that is saved straight into that state.
        workflow = frappe.get_doc("Workflow", workflow_name)
        present = {row.state for row in workflow.states}
        missing_states = [state for state in STATUSES if state not in present]
        for state in missing_states:
            workflow.append("states", {"state": state, "doc_status": "0", "allow_edit": "Sales User"})
        have_transitions = {(row.state, row.action) for row in workflow.transitions}
        missing_transitions = [pair for pair in ACTIONS if ("Pending Review", pair[0]) not in have_transitions]
        for action, next_state in missing_transitions:
            workflow.append("transitions", {"state": "Pending Review", "action": action, "next_state": next_state,
                                           "allowed": "Sales User", "allow_self_approval": 1})
        if missing_states or missing_transitions:
            workflow.save()
            print("Workflow topped up:", missing_states, [pair[0] for pair in missing_transitions])
        else:
            print("Workflow already exists")
    else:
        frappe.get_doc({
            "doctype": "Workflow",
            "workflow_name": "Inquiry Review",
            "document_type": "Inquiry",
            "workflow_state_field": "workflow_state",
            "is_active": 1,
            "send_email_alert": 0,
            "states": [{"state": s, "doc_status": "0", "allow_edit": "Sales User"} for s in STATUSES],
            "transitions": [
                {"state": "Pending Review", "action": action, "next_state": next_state,
                 "allowed": "Sales User", "allow_self_approval": 1}
                for action, next_state in ACTIONS
            ],
        }).insert(ignore_permissions=True)
        print("Workflow Inquiry Review created")

    # Per-line stock is only meaningful if the demo catalogue is actually stock-tracked. The
    # original seed created items with is_stock_item=0 and no Bin rows, so every line resolved to
    # "untracked" and the inventory column told the reviewer nothing.
    from datetime import date

    OPENING_STOCK = {"FILTER-A10": 12, "FILTER-A20": 4, "THERM-S1": 30, "AMBIG-24V": 7}
    for code in OPENING_STOCK:
        if frappe.db.exists("Item", code):
            frappe.db.set_value("Item", code, "is_stock_item", 1)
    frappe.db.commit()

    if not frappe.db.exists("Stock Reconciliation", {"purpose": "Opening Stock", "docstatus": 1}):
        reconciliation = frappe.new_doc("Stock Reconciliation")
        reconciliation.purpose = "Opening Stock"
        reconciliation.company = "Nordic Parts Demo"
        reconciliation.set_posting_time = 1
        reconciliation.posting_date = str(date.today())
        reconciliation.posting_time = "00:00:00"
        # An opening entry balances against an Asset/Liability account, not the usual expense
        # account, or Frappe raises OpeningEntryAccountError.
        reconciliation.expense_account = "Temporary Opening - NPD"
        for code, qty in OPENING_STOCK.items():
            if frappe.db.exists("Item", code):
                reconciliation.append("items", {
                    "item_code": code, "warehouse": "Stores - NPD", "qty": qty, "valuation_rate": 10,
                })
        reconciliation.flags.ignore_permissions = True
        reconciliation.submit()
        print("Opening stock recorded")

    frappe.db.commit()
    print("DONE")
finally:
    if _standalone:
        frappe.destroy()
