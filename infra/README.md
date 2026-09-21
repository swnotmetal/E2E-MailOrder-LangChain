# Local ERPNext environment

The committed compose.yaml is the official frappe/frappe_docker pwd.yml at commit c74f28db98fde650612d02a5353177a9c2df4f34, with the frontend port bound only to 127.0.0.1. Upstream license is included. Images: ERPNext v16.35.0, MariaDB 11.8, Redis 6.2-alpine. This is the upstream disposable demo topology, not a production deployment. Image tags can move; pin image digests after the first successful real acceptance.

Run `powershell -ExecutionPolicy Bypass -File infra/start.ps1` from this repository when Docker Linux is running. It creates isolated order-review-demo containers/volumes and seeds fictional company, customer, linked shipping address, two items, EUR prices, a Sales User API account, and a unique Sales Order integration key. Credentials go to ignored .env. It will not overwrite an existing .env. All network exposure is localhost.

The API user only has Sales User role. If an ERP release requires extra read permissions, verify that precise permission in Desk; do not silently replace the API identity with Administrator. Human CLI approval is a local single-operator boundary, not web authentication. The ERP API identity can create drafts but this application never submits them.

2026-09-21 attempt: Docker daemon unavailable; Ubuntu WSL2 returned HCS_E_HYPERV_NOT_INSTALLED. No ERP containers were started, seed has not been executed against a real ERP, no real Sales Order created. Enable firmware virtualization and Windows Virtual Machine Platform, restart, then retry. No system features were changed automatically.

Inspect: `docker compose -p order-review-demo -f infra/compose.yaml logs create-site`.
Stop while preserving data: `docker compose -p order-review-demo -f infra/compose.yaml stop`.

Acceptance must verify API permissions, address linkage, item pricing, unique constraint, docstatus=0, identical replay and timeout reconciliation against the actual running instance. Passing mock tests is insufficient.


The 2026-09-21 real run used Ubuntu WSL Engine 29.1.3, Compose 2.40.3, and a hidden wsl ... sleep infinity process to keep WSL alive. Frappe API /api/method/ping returned pong; frappe 16.34.0 and erpnext 16.35.0 installed. The seed includes minimal master data normally created by Setup Wizard. The first partial setup was cleaned only after verifying four project-specific volumes created this turn and no ERPNext app/order in the site. Docker Desktop 4.91.0 still crashes on its OTel socket; this independent WSL engine is the operational route. A real import reached review; no Sales Order has been approved or created yet.

