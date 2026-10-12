# Local ERPNext environment

The committed compose.yaml is the official frappe/frappe_docker pwd.yml at commit c74f28db98fde650612d02a5353177a9c2df4f34, with the frontend port bound only to 127.0.0.1. Upstream license is included. Images: ERPNext v16.35.0, MariaDB 11.8, Redis 6.2-alpine. This is the upstream disposable demo topology, not a production deployment. Image tags can move; pin image digests after the first successful real acceptance.

Run `powershell -ExecutionPolicy Bypass -File infra/start.ps1` from this repository when Docker Linux is running. It creates isolated order-review-demo containers/volumes and seeds fictional company, customer, linked shipping address, two items, EUR prices, a Sales User API account, and a unique Sales Order integration key. Credentials go to ignored .env. It will not overwrite an existing .env. All network exposure is localhost.

The API user only has Sales User role. If an ERP release requires extra read permissions, verify that precise permission in Desk; do not silently replace the API identity with Administrator. Human CLI approval is a local single-operator boundary, not web authentication. The ERP API identity can create drafts but this application never submits them.

2026-09-21 attempt: Docker daemon unavailable; Ubuntu WSL2 returned HCS_E_HYPERV_NOT_INSTALLED. No ERP containers were started, seed has not been executed against a real ERP, no real Sales Order created. Enable firmware virtualization and Windows Virtual Machine Platform, restart, then retry. No system features were changed automatically.

Inspect: `docker compose -p order-review-demo -f infra/compose.yaml logs create-site`.
Stop while preserving data: `docker compose -p order-review-demo -f infra/compose.yaml stop`.

Acceptance must verify API permissions, address linkage, item pricing, unique constraint, docstatus=0, identical replay and timeout reconciliation against the actual running instance. Passing mock tests is insufficient.


The 2026-09-21 real run used Ubuntu WSL Engine 29.1.3, Compose 2.40.3, and a hidden wsl ... sleep infinity process to keep WSL alive. Frappe API /api/method/ping returned pong; frappe 16.34.0 and erpnext 16.35.0 installed. The seed includes minimal master data normally created by Setup Wizard. The first partial setup was cleaned only after verifying four project-specific volumes created this turn and no ERPNext app/order in the site. Docker Desktop 4.91.0 still crashes on its OTel socket; this independent WSL engine is the operational route. A real import reached review; no Sales Order has been approved or created yet.

## Local mailbox (Mailpit)

`powershell -ExecutionPolicy Bypass -File infra/start-mailpit.ps1` downloads the Mailpit release binary into ignored `infra/.mailpit/` on first use, then serves SMTP on 127.0.0.1:1025 and a web inbox on http://127.0.0.1:8025. It is localhost-only, and the binary, licence and readme are gitignored.

**This is a local development inbox, not a mail provider.** It exercises real SMTP transport and real MIME decoding; it does not demonstrate IMAP, the Graph API, OAuth, provider-side rules or deliverability, and it must never be described as an enterprise mailbox integration.

End to end, in two terminals:

```powershell
powershell -ExecutionPolicy Bypass -File infra/start-mailpit.ps1
npm run learn
npm run mail:send -- 01-clean
```

The learning lab polls Mailpit every 3s and ingests anything new, so mail appears in its inbox on its own — no third terminal. `LEARN_MAILPIT=off` stops the polling, and `LEARN_MAILPIT_MODE=gemini` makes the poller use the live model instead of deterministic template extraction. The default is template mode so that unattended polling never spends API calls.

`01-clean` carries the labelled fields the template extractor needs, so that walkthrough makes no model calls. Free-form prose such as `natural-clear` extracts nothing in template mode; use the model path for it:

```powershell
npm run mail:send -- natural-clear
npm run mail:ingest -- --gemini
```

`npm run mail:send [fixture]` sends `fixtures/<fixture>.eml`'s body plus `fixtures/<fixture>.pdf` as a real MIME message over SMTP; the fixture's own RFC822 headers are stripped, so they never reappear as prose.

`npm run mail:ingest [--gemini] [--watch]` remains available as a standalone bridge for scripted or unattended use: it lists Mailpit, pulls each unseen message as raw MIME, and posts it to the learning lab's localhost-only `/api/ingest`, where `readSources` decodes it with mailparser and pdfjs before the graph runs. Ingested ids are recorded in ignored `data/mailbox/ingested.json`, so a re-run only picks up new mail.

Verified 2026-10-12: one `01-clean` message was sent over SMTP, ingested, decoded into a 132-character text body plus a real pdfjs page containing "FICTIONAL PURCHASE ORDER", and routed to review with FILTER-A10 at recorded-stock 12 and zero mock-ERP writes.

