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

STATUSES = ["Pending Review", "Qualified", "Rejected"]
ACTIONS = [("Qualify", "Qualified"), ("Reject", "Rejected")]

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

    # Fields added after the DocType already existed; appended in place so a seeded site picks
    # them up instead of needing the table rebuilt.
    LATER_FIELDS = [
        {"fieldname": "lead", "label": "Lead", "fieldtype": "Link", "options": "Lead"},
        {"fieldname": "suggested_reply", "label": "Suggested reply (not sent)", "fieldtype": "Text Editor"},
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

    if frappe.db.exists("Workflow", {"document_type": "Inquiry"}):
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

    frappe.db.commit()
    print("DONE")
finally:
    if _standalone:
        frappe.destroy()
