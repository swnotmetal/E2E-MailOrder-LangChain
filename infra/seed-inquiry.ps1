# Installs or updates the Inquiry DocType, its "Inquiry Review" workflow and the opening stock.
# Idempotent: safe to re-run after any code change to infra/seed-inquiry-doctype.py.
#
# Only needed once per site (fresh volume), or after editing the seed. It does not touch orders.
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $projectRoot
$linuxRoot = (& wsl -d Ubuntu -- wslpath -a $projectRoot).Trim()
if ($LASTEXITCODE -ne 0 -or -not $linuxRoot) { throw 'Ubuntu WSL path conversion failed' }

$compose = "$linuxRoot/infra/compose.yaml"
$cp = { param($source, $target) & wsl -d Ubuntu -u root -- /usr/bin/docker compose -p order-review-demo -f $compose cp $source $target }

& $cp "$linuxRoot/infra/seed-inquiry-doctype.py" backend:/tmp/seed.py
if ($LASTEXITCODE -ne 0) { throw 'Could not copy seed-inquiry-doctype.py into the backend container' }
& $cp "$linuxRoot/infra/run-seed.sh" backend:/tmp/run-seed.sh
if ($LASTEXITCODE -ne 0) { throw 'Could not copy run-seed.sh into the backend container' }

& wsl -d Ubuntu -u root -- /usr/bin/docker compose -p order-review-demo -f $compose exec -T backend sh /tmp/run-seed.sh
if ($LASTEXITCODE -ne 0) { throw 'Inquiry seed failed; read the Python traceback above' }

Write-Host 'Inquiry DocType, workflow and opening stock are in place. Reload http://127.0.0.1:8080 if it was already open.'
