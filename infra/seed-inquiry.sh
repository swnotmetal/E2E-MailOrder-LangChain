#!/usr/bin/env bash
# Linux equivalent of infra/seed-inquiry.ps1: install the Inquiry DocType, its workflow and opening stock.
# Idempotent; safe to re-run. Requires the stack from infra/start.sh.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dc=(docker compose -p order-review-demo -f "$root/infra/compose.yaml")

# Running this before the site exists produces a bare "404 Not Found: frontend does not exist" from
# bench, which looks like a seed bug. Say what actually happened instead.
if ! "${dc[@]}" exec -T -w /home/frappe/frappe-bench backend \
  bench --site frontend execute frappe.client.get_count --kwargs '{"doctype":"DocType"}' >/dev/null 2>&1; then
  echo "site 'frontend' is not ready. Run infra/start.sh first and wait for it to finish." >&2
  exit 1
fi

"${dc[@]}" cp "$root/infra/seed-inquiry-doctype.py" backend:/tmp/seed.py
"${dc[@]}" cp "$root/infra/run-seed.sh" backend:/tmp/run-seed.sh
"${dc[@]}" exec -T backend sh /tmp/run-seed.sh

echo "Inquiry DocType, workflow and opening stock are in place."
