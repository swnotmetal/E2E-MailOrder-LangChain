---
name: order-review
description: Implement or verify this repository's email and purchase-order review workflow, including evidence, human decisions, ERP writes and recovery.
license: MIT
---

Only fictional local customer/order data belongs in fixtures. Never commit credentials or send documents to an external model without the user's informed authorization.

Preserve raw email and PDF-extracted text. Every extracted value needs source, page (PDF), exact quote and offsets into saved text. Missing or ambiguous values stay unresolved; never infer a model number from the first search result.

LangGraph owns routing, interrupt and persisted checkpoints. Deterministic code validates quantities, required fields, approval and duplicate identity. Human approval applies to the reviewed revision, with a reason for resolving source conflicts. Revalidate after edits and before ERP writes.

ERPNext is the real integration target. Mock tests are development evidence only. Create Sales Orders with docstatus=0. Use an ERP-side unique integration key plus reconciliation after uncertain writes; GET-before-POST alone is not concurrency-safe. Never blindly retry a timeout POST.

Run typecheck and behavioral tests after each slice. Cover ambiguity, quantity conflict, stale approval, duplicate imports, concurrent approval and timeout-after-commit. Keep machine test expectations explicitly provisional until human verification. Held-out evaluation inputs and answers must come from the user or an independent human; do not claim self-authored tests establish extraction accuracy or saved labor.
