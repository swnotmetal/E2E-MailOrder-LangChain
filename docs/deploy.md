# Can this run in the cloud for free?

Short answer: **the code checks can, the ERPNext stack cannot — and Cloudflare is the wrong platform
for it.**

New to this kind of deployment? [course-deploy.md](course-deploy.md) is a short primer on what a
cloud host actually gives you, the three layers a port has to cross, and where state lives.

## What the stack actually needs

One `docker compose up` here starts eight ERPNext containers plus MariaDB and Redis:
`backend`, `frontend` (nginx), `websocket`, `queue-long`, `queue-short`, `scheduler`, `redis-cache`,
`redis-queue`, `db`, and the two one-shot jobs `configurator` / `create-site`. On top of that the
GreenMail container. That is a Python web application with a persistent relational database, not a
request/response function.

## Why Cloudflare cannot host it

Checked against the Cloudflare docs on 2026-10-21:

| Cloudflare product | Limit | Why it fails here |
| --- | --- | --- |
| Workers Free | 10 ms CPU per request, 128 MB memory | runs JavaScript/Wasm only — no Python, no Frappe, no `bench` |
| D1 | SQLite-based | ERPNext needs MariaDB 11.8; D1 is not a MariaDB server |
| Containers | **Free: N/A**. Billed on Workers Paid ($5/mo); the smallest instance (`lite`) is 1/16 vCPU / 256 MiB / 2 GB disk | the ERPNext backend alone wants more than 256 MiB, MariaDB more still, and there is no free tier at all |

So the answer to "can Cloudflare be the cyber-philanthropist here" is no: the free tier cannot run
this workload, and the paid tier cannot run it either (256 MiB vs a stack that idles at several GB).

The one thing Cloudflare *could* do is serve a static HTML report of a run from Pages — which buys
nothing, because the artifacts are already in git and in the ERP.

## What is actually free

| Need | Free option | Status |
| --- | --- | --- |
| Typecheck, 61 tests, failure lab on every push | GitHub Actions free minutes (public repo) | done: `.github/workflows/ci.yml`, no Docker, no model calls |
| Boot the real ERPNext stack and run the documented commands | GitHub Actions `ubuntu-latest` (2 vCPU / 7 GB), manual trigger | done: `.github/workflows/integration.yml` |
| A real Docker host you can open in a browser, on demand | **GitHub Codespaces** (GitHub Free: 120 core-hours + 15 GB-month) | see below — `.devcontainer/devcontainer.json` is committed |
| ERPNext reachable 24/7 for a human to click | Oracle Cloud **Always Free** ARM VM (4 OCPU / 24 GB) or a ~€4/mo ARM VPS | runbook: [deploy-oracle.md](deploy-oracle.md); needs an account and a domain |

### Codespaces: the free option that needs no cloud account

Open the repo → **Code → Codespaces → Create codespace on main**. The committed devcontainer gives
you Ubuntu 24.04, Docker (docker-in-docker) and Node 22, on a 2-core / 8 GB machine:

```bash
bash infra/start.sh
bash infra/seed-inquiry.sh
```

Port **8080** is forwarded automatically; the Ports tab gives you a public `https://…app.github.dev`
URL, and that URL is what you put in `ERP_URL` on your laptop. Nothing to install locally, no card.

Honest limits, because they decide whether this fits:

- **120 core-hours/month on GitHub Free** = **60 hours on a 2-core machine**. A codespace that is
  running but unused still burns them; it stops after 30 minutes idle by default.
- **15 GB-month of storage.** The ERPNext images alone are ~2 GB, so create/delete codespaces
  deliberately rather than hoarding several.
- **Not 24/7.** When the codespace stops, the public URL dies. This is for "open it, drive the flow,
  close it", not for a permanent demo link.
- Creating the site takes ~5–10 minutes the first time in a fresh codespace.

### Google Cloud: no

Verified 2026-10-21:

- **Always Free** is one `e2-micro` in `us-west1` / `us-central1` / `us-east1`: shared vCPU,
  **1 GB RAM**, 30 GB disk. ERPNext plus MariaDB plus Redis does not fit in 1 GB — this stack idles
  at several GB.
- The **$300 / 90-day Free Trial** would cover a bigger VM, but it is a trial: when it ends, the
  billing account closes, resources stop, and data is deleted unless you upgrade to a paid account.
  The $300 credit also cannot pay for Gemini API usage.

So GCP is fine for *learning* for three months and wrong for "free forever" here.

### How to run the integration job

Actions → **ERP integration (manual)** → *Run workflow*. It executes, in order:

```
bash infra/start.sh          # compose up, wait for create-site, seed masters, write .env.erp
bash infra/seed-inquiry.sh   # Inquiry DocType + workflow + opening stock
bash infra/start.sh          # again: proves both scripts are idempotent
bash infra/seed-inquiry.sh
bench execute frappe.client.get_list ...   # asserts the review surface exists
bench execute frappe.client.get_count ...  # asserts opening stock exists
```

No `GOOGLE_API_KEY` is needed: the job stops before `npm run inquiry:sync`, which is the only step
that calls a model. That keeps CI free and keeps the model ledger out of automated runs.

### Evidence level

- `infra/start.sh` and `infra/seed-inquiry.sh` were **run for real** in the Ubuntu WSL engine on
  2026-10-21: stack came up, both seeds completed, `Inquiry` reported "already exists" on the second
  run.
- `.github/workflows/integration.yml` is **unverified until its first manual run** — I cannot execute
  GitHub's runners from here. If it fails, the failure is in the runner assumptions (docker group
  access, image pull time), not in the scripts.

## Moving to a real VM

Full walkthrough for Oracle's free ARM tier: [deploy-oracle.md](deploy-oracle.md).

`infra/start.sh` is host-agnostic: `docker`, `bash`, nothing Windows-specific. On a VM:

1. Install Docker Engine and add your user to the `docker` group.
2. `git clone`, then `bash infra/start.sh && bash infra/seed-inquiry.sh`.
3. `.env.erp` contains `ERP_URL=http://127.0.0.1:8080`; change it to the VM address before running
   `npm run inquiry:sync`.
4. Put a TLS proxy in front and do **not** expose MariaDB or GreenMail. The demo compose file binds
   everything to `127.0.0.1` and that binding is deliberate.
