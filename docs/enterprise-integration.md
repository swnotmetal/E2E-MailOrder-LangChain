# Enterprise Integration Path: Email to ERP

## Conclusion

In a real organization, this application would not connect an inbox directly to an ERP database. A safer boundary is: the email system receives messages, a queue absorbs bursts, LangGraph provides durable orchestration, a human-review service grants authority, and an ERP adapter calls supported business APIs. The model receives neither ERP write credentials nor permission to send email.

This repository is a learning and engineering portfolio project. It does not need to prove commercial ROI; it needs to demonstrate these boundaries, recovery paths, and observable evidence honestly.

## Target topology

```text
Microsoft Graph / Gmail API / IMAP webhook
                 |
                 v
        inbound email service
        stores raw MIME, attachments, message id
                 |
                 v
       queue / dead-letter queue
                 |
                 v
 LangGraph worker + durable checkpointer
   |             |                 |
   |             |                 +--> LangSmith trace (fictional/authorized data only)
   |             +--> read-only tools: customer, catalog, stock, price, lead time
   v
 human-review API/UI (SSO, RBAC, revision)
   |                         |
   | approved order          | approved reply
   v                         v
 ERP write worker         email send worker
 Draft + idempotency key  reply-to/thread id
   |                         |
   +---- audit/reconciliation <---+
```

## Responsibilities and failure handling

| Layer | Responsibility | Failure behavior |
| --- | --- | --- |
| Email ingestion | Validate webhooks, preserve raw content and attachments, deduplicate message IDs | Let the provider redeliver ingestion failures; never discard source evidence before parsing |
| Queue | Buffer bursts, count retries, hold dead letters | Retry transient failures a bounded number of times; route permanent failures to humans |
| LangGraph | Classify, extract, route, interrupt, and checkpoint | Resume from a persisted node without repeating confirmed side effects |
| Read-only ERP tools | Look up customers, catalog, inventory, price, and lead time | Mark unavailable facts as unknown; do not invent an answer or switch models |
| Human review | Edit drafts, explain conflicts, approve an exact revision | Reject stale approval and require review of the latest content |
| ERP write worker | Revalidate, create a `docstatus=0` Draft, enforce idempotency, reconcile | After an uncertain POST, reconcile by unique key before deciding whether to retry |
| Email outlet | Send an approved reply and retain the thread ID | Use a send idempotency key; a send failure does not roll back an ERP result |

## Mapping to this repository

- `src/model.ts`: the fixed Gemini 2.5 Flash-Lite understanding boundary; it has no ERP write permission.
- `src/workflow.ts`: LangGraph routing, interrupts, revision semantics, and checkpoints.
- `src/erp.ts`: ERPNext REST adapter; types separate inventory reads from Draft writes.
- `src/learn.html` and `scripts/learn.ts`: a single-machine learning UI, not an enterprise connector or production review console.
- `test/mock-erp.ts`: a development test double; its results are mock evidence only.

The missing enterprise components are a provider-specific email connector, an independent queue, SSO/RBAC, long-running workers, an outbound mail service, and a production database checkpointer. They should be added one at a time.

## Why mocked.site is not the ERP replacement

As observed on 2026-09-23, [mocked.site](https://mocked.site/) provides hosted ERP mock APIs with file-backed state rather than a drop-in database. Its published scenarios focus on SAP S/4HANA supplier invoices and Sage Intacct accounts-payable bills/payments. The [SAP mock dashboard](https://sap.mocked.site/ui.php) likewise exposes suppliers, cost centers, general-ledger accounts, and supplier-invoice endpoints.

This project handles customer inquiries, inventory, and Sales Orders. Mapping those operations onto accounts-payable endpoints would make the demonstration less coherent and would not replace the required customer, item, inventory, address, and Sales Order APIs.

The current choice is therefore to keep a local ERPNext-compatible mock that matches the domain. A mocked.site adapter would make sense only if it adds Sales Order/inventory endpoints, or if this repository gains a separate supplier-invoice scenario. Published demo credentials must never be committed.

## Recommended sequence

1. Run the mock ERP as a separate process and connect the learning application through `LEARN_ERP_BASE_URL`. This network boundary is already available.
2. Add a mock email provider that accepts a webhook, persists raw MIME/message ID, and enqueues work.
3. Move from an in-memory checkpoint to disk SQLite or Postgres and demonstrate interrupt recovery after a service restart.
4. Add an “approve but do not send” email outlet, then introduce separate send approval and idempotency records.
5. Replace the mock base URL with an isolated ERPNext test instance while preserving the same adapter contract.

### Exercise the separate ERP boundary

Start the localhost-only, fictional ERPNext-compatible service in one terminal:

```powershell
npm run mock:erp
```

Connect the learning application from a second terminal:

```powershell
$env:LEARN_ERP_BASE_URL='http://127.0.0.1:3211'
npm run learn
```

Stop the first process and submit an inbox message to observe an ERP read failure without an ERP write. `/__mock/status` and `/__mock/reset` exist only in this local teaching substitute; they are not ERPNext APIs.
