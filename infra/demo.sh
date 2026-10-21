#!/usr/bin/env bash
# One command for the whole loop on Linux (Codespaces, a VM, CI). Same five steps as demo.ps1:
# start -> install the Inquiry surface -> send test/mails -> pull over IMAP -> file Inquiries.
# Only the last step calls a model.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

step() { printf '\n=== %s ===\n' "$1"; }

step 'Start the ERP'
bash infra/start.sh

step 'Install the Inquiry surface'
bash infra/seed-inquiry.sh

step 'Send test mails to GreenMail'
MAILPIT_SMTP=127.0.0.1:3025 npm run --silent mail:tests

step 'Pull mail into ERPNext'
docker compose -p order-review-demo -f "$root/infra/compose.yaml" exec -T -w /home/frappe/frappe-bench backend \
  bench --site frontend execute frappe.email.doctype.email_account.email_account.pull

step 'File Inquiries from that mail'
npm run --silent inquiry:sync

printf '\nDone. Review in ERPNext: http://127.0.0.1:8080/app/inquiry\n'
