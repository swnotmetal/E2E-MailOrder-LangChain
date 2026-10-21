# Commands, in the order you run them

Nothing here is optional magic: every command below is either **required for the loop** or marked
**optional**. Explanations are next to each command, and the confusing parts are unpacked in
[Appendix A](#appendix-a-anatomy-of-the-two-wsl-commands-you-actually-type).

## Where things run

| Plane | What lives there | How you reach it |
| --- | --- | --- |
| Windows PowerShell | the repo, `npm`, the `.ps1` helpers | your terminal |
| WSL Ubuntu → Docker engine | ERPNext stack (backend, db, redis, queue, scheduler, nginx, GreenMail) | `wsl -d Ubuntu -u root -- docker …` (wrapped by the `.ps1` files) |
| Browser | the only review surface: ERPNext Desk | <http://127.0.0.1:8080> |
| Node process | the LangGraph workflow, `npm run …` | your terminal |

The ERP is **not** on Docker Desktop. It runs in the Ubuntu WSL Docker engine, because Docker
Desktop keeps crashing on this machine's OTel socket. That single fact is why every ERP command is
wrapped in `wsl -d Ubuntu -u root --`.

---

## 0. First time only

```powershell
npm ci
```

Installs the exact dependency tree from `package-lock.json`. Do this once per clone.

```powershell
# .env — model key for the live paths. Never committed.
GOOGLE_API_KEY=<your key>
```

`npm run inquiry:sync` needs `GOOGLE_API_KEY`; deterministic tests do not. `.env.erp` is written by
`start-wsl.ps1`, never by hand.

---

## 1. Start the ERP — required, every session

```powershell
.\infra\start-wsl.ps1
```

One script does six things, in order. If any step fails, it throws and stops:

1. Converts the repo path to a Linux path (`D:\codes\Langgraph project` → `/mnt/d/codes/Langgraph project`), because `docker` inside WSL only understands Linux paths.
2. Keeps WSL alive with a hidden `wsl -d Ubuntu -- sleep infinity`. Without a live WSL session, the containers die when the CLI call returns.
3. `docker compose -p order-review-demo -f <linux path>/infra/compose.yaml up -d` — starts the stack under the project name `order-review-demo`.
4. Polls `create-site` until it exits with code 0 (up to 10 minutes). `configurator` and `create-site` are one-shot setup jobs, so "exited" is success, not a crash.
5. Copies `infra/seed.py` into the backend and runs it through `bench console`: fictional company, customer, linked shipping address, items, prices, the Sales User API account.
6. Writes `.env.erp` (gitignored) once, then deletes the temporary copy inside the container.

Wait for exactly:

```
Local ERPNext demo is ready on http://127.0.0.1:8080. API credentials are in ignored .env.erp.
```
Status line reads `creating the site: 300s elapsed, 97.0% cpu` while it works. `bench new-site`
prints nothing for minutes at a time, so CPU is the only honest progress signal. Expect ~3-5 minutes
on a 4-core desktop and **15-30 minutes on a 2-vCPU Codespaces machine**; the script gives up after 45.
Re-running it is safe and fast when the site already exists.

---

## 2. Install the Inquiry DocType — once per fresh site, or after editing the seed

```powershell
.\infra\seed-inquiry.ps1
```

Wraps the three steps you were typing by hand:

| Step | Why |
| --- | --- |
| `compose cp seed-inquiry-doctype.py backend:/tmp/seed.py` | the file must exist inside the container; `compose cp` finds the container by project name, so you never hardcode `order-review-demo-backend-1` |
| `compose cp run-seed.sh backend:/tmp/run-seed.sh` | the shell quoting for `bench console` lives in one file instead of in your terminal |
| `compose exec -T backend sh /tmp/run-seed.sh` | runs the seed in the backend venv, where the Frappe site context is already loaded |

What the seed creates: the `Inquiry` DocType and its `Inquiry Line` child table, the
`Inquiry Review` workflow (`Pending Review` → `Qualified` / `Rejected` / `Screened Out`), and opening
stock so per-line availability has something to read. It is idempotent — re-running never duplicates.

`start-wsl.ps1` does **not** run this; it only seeds the base ERP masters.

---

## 3. Mail — optional, only when you want new test mail

You need **one** of two inboxes, and they are not interchangeable:

| Inbox | Port | IMAP? | Use it for |
| --- | --- | --- | --- |
| GreenMail (in `compose.yaml`, started by step 1) | SMTP 3025 / IMAP 3143 | **yes** | the real path — ERP's `Email Account` pulls from here |
| Mailpit (`start-mailpit.ps1`) | SMTP 1025 / HTTP 8025 | no | eyeballing a fixture in a web inbox |

ERPNext pulls over IMAP, and Mailpit deliberately implements only SMTP. That is the whole reason
GreenMail exists in this stack.

```powershell
.\infra\start-mailpit.ps1      # optional: only if you want the web inbox on :8025
```

```powershell
$env:MAILPIT_SMTP='127.0.0.1:3025'
npm run mail:tests
```

`mail:tests` posts **one file per message** from `test/mails/`, sorted by file name, over SMTP to the
host in `MAILPIT_SMTP`. The default is `127.0.0.1:1025` (Mailpit), so you **must** set it to `:3025`
to feed GreenMail, which is what the ERP reads. Send a single file with
`npm run mail:tests -- test/mails/01-rfq-urgent-stock-verification-for-next-q.txt`.

### The mail file format

Strict on purpose — a wrong line fails immediately with the file name and the line number, instead
of being guessed at:

```
From: someone@example.com          <- line 1
To: sales@example.invalid          <- line 2
Subject: your subject              <- line 3
                                   <- line 4 must be blank
body starts here                   <- line 5 onward
```

One file = one message, so editing content can never merge two mails or drop a separator. Add a mail
by copying a file and changing the three header lines.

---

## 3b. Or just run the whole loop — `npm run demo`

```powershell
npm run demo
```

The five steps above, in one command, with no flags: start the ERP (idempotent) → install the Inquiry
surface (idempotent) → send every file in `test/mails/` to GreenMail → pull over IMAP → file the
Inquiries. Only the last step calls a model, so anything that fails before it costs nothing.

After you change a mail file, that single command is the whole workflow.

---

## 4. Pull that mail into ERPNext — required after sending

```powershell
wsl -d Ubuntu -u root -- /usr/bin/docker compose -p order-review-demo -f "$((wsl -d Ubuntu -- wslpath -a "$PWD").Trim())/infra/compose.yaml" exec -T backend bash -lc "cd /home/frappe/frappe-bench && bench --site frontend execute frappe.email.doctype.email_account.email_account.pull"
```

Breaks down as: `compose exec -T backend` = run inside the ERP backend container without a TTY;
`bench --site frontend execute <dotted path>` = call that Python function once; `email_account.pull`
= "every enabled Email Account, check IMAP now". Frappe then creates a `Communication` per message
(deduplicated by `Message-ID`, so pulling twice is harmless) and a `Lead` for an unknown sender,
because the Email Account's `Append To` is `Lead`.

Optional trigger: the `scheduler` container also pulls on its own schedule. The manual call just
makes it immediate.

---

## 5. Turn mail into ERP records — required

```powershell
npm run inquiry:sync
```

The pipeline. In order:

1. Loads `.env.erp` and `.env`; refuses to run without `ERP_INBOX_TOKEN` and `GOOGLE_API_KEY`.
2. Lists `Lead`s, then each `Communication`, skipping any `Message-ID` already filed.
3. Runs the deterministic pre-screen (`src/triage.ts`). A newsletter or pitch is filed as an `Inquiry`
   in `Screened Out` and costs **no model call**.
4. Otherwise runs the LangGraph workflow against a read-only ERP: extraction with source evidence →
   per-line item and stock resolution → AI draft reply. Every ERP write on this path is a no-op stub.
5. Files one `Inquiry` with the draft reply, the extracted lines, and its availability per line.
6. Second pass: every Inquiry a human moved to `Qualified` gets a **draft Quotation** built from the
   lines that actually matched an item. The Quotation name is written back onto the Inquiry.

Re-running is idempotent: it keys on the mail's `Message-ID` and on the Inquiry's own name.

---

## 6. Review — this is the human step, and it is in the browser

Open <http://127.0.0.1:8080> (Administrator / admin, local demo only) and go to the **Inquiry** list.

- **Qualify** a row → the next `inquiry:sync` drafts the Quotation.
- **Reject** → nothing is written.
- **Screened Out** → nothing to do; it was never procurement mail.
- For orders: the Sales Order is already a draft (`docstatus=0`). Submit it to **approve**, or leave /
  delete it to reject. There is no approve button anywhere in this repo.

---

## 7. Resume the workflow from that decision — required for orders

```powershell
npm run review:sync
```

The order path paused on a LangGraph `interrupt` when it wrote the draft. This command reads each
draft's `docstatus` and `modified_by` from ERP, then resumes the graph with
`{action:'approve'|'reject', revision, actor, source:'erpnext'}`. It cannot approve anything itself —
it only observes what a human already did in ERPNext.

`--dry-run` prints what it would resume without touching graph state.

---

## 8. Stop, preserving data — required before shutdown

```powershell
.\infra\stop-wsl.ps1
```

Equivalent to the `wslpath` + `compose stop` two-liner, with the path conversion and quoting done
for you. `stop` (not `down`) keeps the volumes: the site, the seeded masters, your Inquiries and the
SQLite checkpoints all survive, so the next `start-wsl.ps1` is a few seconds.

---

## 9. Verify the code — no Docker, no model, no network

```powershell
npm run check        # tsc --noEmit: types only
npm test             # 75 tests, tsx --test test/*.test.ts
npm run failure-lab  # drives the graph against an in-process mock ERP
npm run doctor       # read-only: config, ERP reachability, token, Inquiry DocType, GreenMail ports
```

`doctor` is the first thing to run when something does not work. It is read-only and calls no model:
it names the broken layer instead of leaving you to guess between config, network, permissions and
the mailbox. Exit code 1 means a blocking problem.

These are what CI runs (`.github/workflows/ci.yml`). They never touch ERPNext, GreenMail or Gemini:
deterministic tests make no live model calls, which is why they are safe to run constantly.

---

## 10. Run the whole ERP loop in CI instead — optional

`.github/workflows/integration.yml` boots the real stack on a GitHub runner and re-runs the seeds to
prove they are idempotent. Trigger it manually: **Actions → ERP integration (manual) → Run workflow**.

It runs the same two commands as steps 1 and 2, so if the job is green, `infra/start.sh` and
`infra/seed-inquiry.sh` work on a clean Linux host — which is also how you would deploy to a VM.
It deliberately stops before `npm run inquiry:sync`: that step needs `GOOGLE_API_KEY` and spends
money, and CI should not do either.

Why not Cloudflare, and what else is free: [deploy.md](deploy.md).

---

## Appendix A: anatomy of the two WSL commands you actually type

The stop command you pasted is two commands because of one constraint: **`docker compose -f` needs a
Linux path, and your repo path is a Windows path containing a space.**

```powershell
$r = (wsl -d Ubuntu -- wslpath -a "$PWD").Trim()
wsl -d Ubuntu -u root -- /usr/bin/docker compose -p order-review-demo -f "$r/infra/compose.yaml" stop
```

Line 1, piece by piece:

| Piece | Meaning |
| --- | --- |
| `wsl -d Ubuntu` | run the next command in the Ubuntu distro (your Docker engine lives there) |
| `--` | everything after this is a Linux command line, not a `wsl.exe` flag |
| `wslpath -a` | convert a Windows path to its Linux form, `-a` = absolute |
| `"$PWD"` | PowerShell's current directory, quoted because it contains a space |
| `.Trim()` | strip the trailing newline `wsl.exe` adds, so it does not break the next command |

Line 2, piece by piece:

| Piece | Meaning |
| --- | --- |
| `-u root` | run as root. Root can read the Docker socket without joining a group; nothing else here needs privilege |
| `/usr/bin/docker` | absolute path, because `docker` is not always on root's `PATH` in WSL |
| `compose` | use the Compose v2 plugin |
| `-p order-review-demo` | the project name. This is what makes the containers, network and volumes **this** project's and not another stack's |
| `-f "$r/infra/compose.yaml"` | the compose file, given as the Linux path from line 1 and quoted for the space |
| `stop` | stop the containers, keep volumes. `down` would delete the network and containers |

That is all line 1 exists for: to avoid you typing `/mnt/d/codes/Langgraph project` by hand. Both
`.ps1` helpers do exactly this internally, which is why you can now ignore the whole dance.

## Appendix B: what "one-shot exited" means in `docker compose ps`

`configurator` and `create-site` show `Exited (0)`. That is correct — they are setup jobs, not
services. `start-wsl.ps1` waits for `create-site` to reach `exited 0` and treats any other exit as a
failure. A real failure shows as `Exited (1)` or a container stuck in `Created`; then read
`docker compose -p order-review-demo -f infra/compose.yaml logs create-site`.
