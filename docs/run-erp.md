# Run the local ERPNext and connect the lab

One page, copy-paste. Everything is bound to `127.0.0.1`; nothing is exposed publicly.

> The ERPNext runs in the **Ubuntu WSL Docker engine**, not Docker Desktop. `infra/start-wsl.ps1` keeps WSL alive and starts the stack.

## 1. Start the ERP

From the repository root:

```powershell
.\infra\start-wsl.ps1
```

Wait for:

```
Local ERPNext demo is ready on http://127.0.0.1:8080. API credentials are in ignored .env.erp.
```

The `configurator` and `create-site` containers exiting with code 0 is normal — they are one-shot setup jobs.

## 2. Open the ERP UI

- URL: <http://127.0.0.1:8080>
- Login: `Administrator` / `admin` (local demo only)

The API user in `.env.erp` is a separate **Sales User**, not Administrator. It can read and create drafts / work items; it cannot delete.

## 3. Credentials (`.env.erp`, gitignored)

`infra/start-wsl.ps1` writes or keeps this file:

```
ERP_URL=http://127.0.0.1:8080
ERP_COMPANY=Nordic Parts Demo
ERP_TOKEN=<api_key>:<api_secret>
```

Never copy this token by hand. Every HTTP header value must be Latin-1, so a single non-ASCII character (for example a Chinese character left in from a placeholder) makes every request fail with `Cannot convert argument to a ByteString because the character at index … is greater than 255`.

## 4. Connect the lab to the real ERP

Read the token from `.env.erp` instead of pasting it:

```powershell
$tok = (Get-Content .env.erp | Where-Object { $_ -like 'ERP_TOKEN=*' }) -replace '^ERP_TOKEN=',''
$env:LEARN_ERP_BASE_URL = 'http://127.0.0.1:8080'
$env:LEARN_ERP_AUTH     = "token $tok"
$env:LEARN_ERP_COMPANY  = 'Nordic Parts Demo'
npm run learn
```

Open <http://127.0.0.1:3210>. The summary line should read `external ERP (no mock write counter)`.

With **no** env vars, `npm run learn` uses the in-process mock ERP instead — that is the fastest way to try the UI, and it needs neither WSL nor the ERP. The lab's "Clear lab state" never deletes ERP data: it only clears the in-memory lab state.

## 5. Use the CLI against the real ERP

```powershell
$env:ERP_ENV_FILE = '.env.erp'
npm run cli -- import fixtures/01-clean.eml fixtures/01-clean.pdf
npm run cli -- show <id>
```

## 6. What to look for in ERPNext

| Mail | ERP artifact | Where |
| --- | --- | --- |
| inquiry / conditional | `ToDo` work item (reply suggestion, never sent) | ToDo list |
| purchase order | Sales Order with `docstatus=0` (draft, never submitted) | Sales Order list |

A purchase order needs a real customer, a linked shipping address, uniquely matched items and a valid date. A natural-language order is normalised (dates to `YYYY-MM-DD`, units to the item's stock UOM, punctuation-insensitive address matching) before validation; a genuinely ambiguous item still stops for a human.

## 7. Stop (preserving data)

```powershell
$r = (wsl -d Ubuntu -- wslpath -a "$PWD").Trim()
wsl -d Ubuntu -u root -- /usr/bin/docker compose -p order-review-demo -f "$r/infra/compose.yaml" stop
```

## Troubleshooting

- **`connection refused` on :8080** — WSL was terminated. Re-run `.\infra\start-wsl.ps1`.
- **`EADDRINUSE` on :3210** — an old lab is still running: `Get-NetTCPConnection -LocalPort 3210 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess }`.
- **`Cannot convert argument to a ByteString`** — `LEARN_ERP_AUTH` / `ERP_TOKEN` contains a non-ASCII character. Re-read it from `.env.erp` (step 4).
- **Site creation looks stuck** — inspect `docker compose -p order-review-demo -f infra/compose.yaml logs create-site`.

## Verified

2026-10-20: `createDraft` created a real Sales Order draft (`docstatus=0`), an identical replay reconciled to the same order, and changed content under the same PO was refused (`DUPLICATE_CHANGED_OR_NOT_DRAFT`); the test order was then deleted. See [Verification](verification.md).
