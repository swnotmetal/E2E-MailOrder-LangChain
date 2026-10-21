#!/usr/bin/env bash
# Linux/macOS equivalent of infra/start-wsl.ps1: bring up the disposable ERPNext demo.
# Works on any host with a Docker engine (a VM, a CI runner, or WSL). No Windows-specific calls.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$root/infra/compose.yaml"
dc=(docker compose -p order-review-demo -f "$compose_file")

"${dc[@]}" up -d

# configurator and create-site are one-shot setup jobs: "exited 0" is success, not a crash.
# Status and exit code are read as two separate fields on purpose. Asking docker inspect for
# "{{.State.Status}} {{.State.ExitCode}}" prints "running 0" while the job is still working, and
# matching on a single combined string mistook that for a failure on a fresh volume.
created=0
for _ in $(seq 1 240); do
  status="$(docker inspect order-review-demo-create-site-1 --format '{{.State.Status}}' 2>/dev/null || echo missing)"
  code="$(docker inspect order-review-demo-create-site-1 --format '{{.State.ExitCode}}' 2>/dev/null || echo -1)"
  if [ "$status" = "exited" ]; then
    if [ "$code" = "0" ]; then created=1; break; fi
    echo "site creation failed with exit code $code" >&2
    "${dc[@]}" logs --tail 80 create-site >&2
    exit 1
  fi
  case "$status" in
    created|running|restarting|missing) sleep 5 ;;
    *) echo "unexpected create-site state: $status" >&2; "${dc[@]}" logs --tail 80 create-site >&2; exit 1 ;;
  esac
done
if [ "$created" != "1" ]; then
  echo "site creation exceeded 20 minutes; still $status" >&2
  "${dc[@]}" logs --tail 80 create-site >&2
  exit 1
fi

"${dc[@]}" cp "$root/infra/seed.py" backend:/tmp/order-review-seed.py
"${dc[@]}" cp "$root/infra/seed-run.py" backend:/tmp/order-review-run.py
"${dc[@]}" cp "$root/infra/run-seed.sh" backend:/tmp/run-seed.sh
# Reuses the same bench-console wrapper as the inquiry seed instead of a heredoc, which leaves the
# console waiting on "Do you really want to exit".
"${dc[@]}" exec -T backend sh /tmp/run-seed.sh /tmp/order-review-run.py

if [ ! -f "$root/.env.erp" ]; then
  "${dc[@]}" cp backend:/tmp/order-review.env "$root/.env.erp"
fi
"${dc[@]}" exec -T backend rm -f /tmp/order-review.env

echo "ERPNext demo is ready on http://127.0.0.1:8080. API credentials are in ignored .env.erp."
