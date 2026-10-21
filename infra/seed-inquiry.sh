#!/usr/bin/env bash
# Linux equivalent of infra/seed-inquiry.ps1: install the Inquiry DocType, its workflow and opening stock.
# Idempotent; safe to re-run. Requires the stack from infra/start.sh.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dc=(docker compose -p order-review-demo -f "$root/infra/compose.yaml")

"${dc[@]}" cp "$root/infra/seed-inquiry-doctype.py" backend:/tmp/seed.py
"${dc[@]}" cp "$root/infra/run-seed.sh" backend:/tmp/run-seed.sh
"${dc[@]}" exec -T backend sh /tmp/run-seed.sh

echo "Inquiry DocType, workflow and opening stock are in place."
