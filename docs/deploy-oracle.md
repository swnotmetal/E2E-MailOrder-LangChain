# Deploy to Oracle Cloud Always Free — a runbook

This runs the whole demo (ERPNext + GreenMail) on Oracle's free ARM VM. It is the only
"free forever" option that fits this stack; [deploy.md](deploy.md) explains why Cloudflare does not.

**What you end up with:** a VM running `docker compose`, ERPNext reachable on your domain, and the
same `npm run inquiry:sync` loop you already run locally — pointed at the VM instead of localhost.

**Time:** ~30 minutes, most of it waiting for images to pull.
**Cost:** $0 on Always Free, if you stay inside the limits in the last section.

**Verified facts used here** (checked 2026-10-21): `frappe/erpnext:v16.35.0`,
`greenmail/standalone:2.1.0`, `mariadb:11.8` and `redis:6.2-alpine` all publish **arm64** images, so
the free Ampere A1 shape runs them natively — no emulation.

---

## 1. Account and region

Sign up at <https://www.oracle.com/cloud/free/>. You need a card for identity verification; Always
Free resources are not charged.

Pick a **home region** close to you. You cannot change it later without a new account. Prefer a
region where "Ampere A1" capacity is usually available; if you hit `Out of host capacity` in step 4,
that is a regional supply issue, not your mistake.

## 2. Network

Console → **Networking → Virtual Cloud Networks → Create VCN**.

- Name: `langorder-vcn`
- Choose **Create VCN with Internet Connectivity** (this creates the public subnet, internet gateway
  and route table for you).

Then open the **public subnet → Security List → Add Ingress Rules**:

| Source | Protocol | Port | Why |
| --- | --- | --- | --- |
| your IP `/32` | TCP | 22 | SSH, and only from you |
| `0.0.0.0/0` | TCP | 80 | ACME challenge + HTTP→HTTPS redirect |
| `0.0.0.0/0` | TCP | 443 | the ERP |

Do **not** open 3306 (MariaDB), 6379 (Redis), 3025/3143 (GreenMail) or 8080. The compose file binds
everything except `frontend` to loopback on purpose.

## 3. Instance

**Compute → Instances → Create instance**.

- Image: **Ubuntu 24.04** (aarch64)
- Shape: **Ampere → VM.Standard.A1.Flex**, **4 OCPU / 24 GB** — this is the whole Always Free ARM
  allowance in one machine
- Boot volume: 100 GB is comfortable (Always Free includes 200 GB of block storage in total)
- SSH keys: upload your public key, or let Oracle generate a pair and download the private key
- **Assign a public IPv4 address**: yes (Always Free includes one)

## 4. First login and Docker

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@<VM_PUBLIC_IP>
sudo apt-get update && sudo apt-get -y upgrade
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
newgrp docker          # or log out and back in
docker compose version # must print v2.x
```

`get.docker.com` installs Docker Engine and the compose plugin. The `usermod` line is what lets you
run `docker` without `sudo` — this is exactly the assumption `infra/start.sh` makes.

## 5. Get the code and start the stack

```bash
sudo apt-get -y install git
git clone https://github.com/swnotmetal/langorder-ai.git
cd langorder-ai
bash infra/start.sh
bash infra/seed-inquiry.sh
```

`start.sh` is the Linux twin of `start-wsl.ps1`: compose up → wait for the one-shot `create-site` job
→ seed fictional masters → write `.env.erp`. First run pulls ~2 GB of images, so give it 10 minutes.
Wait for:

```
ERPNext demo is ready on http://127.0.0.1:8080. API credentials are in ignored .env.erp.
```

Check it from inside the VM before touching a proxy:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080
```

`200` means nginx is serving the site.

## 6. Put it behind TLS

Oracle gives you a public IP but no hostname. Two honest options:

**A. With a domain (recommended).** Point an `A` record at the public IP, then use Caddy, which
obtains a certificate automatically:

```bash
sudo apt-get -y install debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get -y install caddy
```

`/etc/caddy/Caddyfile`:

```
erp.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

`sudo systemctl reload caddy`. Then tell Frappe its own address, so links it generates are correct:

```bash
cd ~/langorder-ai
docker compose -p order-review-demo -f infra/compose.yaml exec -T -w /home/frappe/frappe-bench \
  backend bench --site frontend set-config host_name https://erp.example.com
```

**B. Without a domain.** Leave it on `http://<VM_IP>:8080` for a quick look by changing the one
published port in `infra/compose.yaml` from `127.0.0.1:8080:8080` to `8080:8080` and restarting.
Traffic is then plaintext: do this only temporarily, and change the Administrator password first.

## 7. Point the local workflow at the VM

On your laptop, `.env.erp` must describe the remote ERP. Copy the token from the VM's `.env.erp`:

```powershell
# laptop
ERP_URL=https://erp.example.com
ERP_COMPANY=Nordic Parts Demo
ERP_TOKEN=<api_key>:<api_secret>
```

Then the same loop as always:

```powershell
npm run inquiry:sync
npm run review:sync
```

Nothing else changes: the API surface, the `Inquiry` DocType and the review workflow are identical.

## 8. Mail on a remote host

Locally, GreenMail listens on `127.0.0.1:3025` so `mail:tests` can post straight into it. On the VM
that port is **not** published to the internet (by design). Three ways forward:

- run `npm run mail:tests` **on the VM** after `npm ci`, then pull: simplest, keeps the demo closed;
- or use a real IMAP mailbox: create an `Email Account` in ERPNext pointing at a real provider, and
  skip GreenMail entirely — this is what the code path is modelled on;
- or temporarily publish 3025 and restrict it to your IP in the security list. Never leave it open.

## 9. Guard rails on a free account

- **Change the Administrator password** (`admin` is a local-demo value) and keep the API user on
  `Sales User` only. Do not promote it to `System Manager` to "make things work".
- **Budget alerts**: Billing → Budgets → create a $1 budget with an alert. Always Free should stay at
  $0; an alert tells you the moment a paid resource appears (a second block volume, a reserved IP
  beyond the free one).
- **Idle reclaim**: Oracle may reclaim Always Free compute that looks unused. Check the current policy
  in the console before relying on it for a long-lived demo, and keep a copy of `.env.erp` outside
  the VM.
- **GreenMail is a test server.** With auth disabled it accepts any login. It is bound to loopback,
  and it must stay that way.

## 10. What this does and does not prove

- It proves the stack is host-portable: the same `infra/start.sh` runs on WSL and on a clean Ubuntu
  ARM VM.
- It does not turn the demo into a product: one site, one company, fictional data, an `admin`
  password, and a review workflow a human drives by hand.
- Steps 6–8 are written from the platform docs and the image/architecture facts above; they were
  **not executed by the author on an Oracle account**. The parts that were executed — `infra/start.sh`
  and `infra/seed-inquiry.sh` — were run twice in the local Ubuntu WSL engine on 2026-10-21 and are
  idempotent.
