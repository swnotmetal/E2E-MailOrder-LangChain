$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $projectRoot
$linuxRoot = (& wsl -d Ubuntu -- wslpath -a $projectRoot).Trim()
if ($LASTEXITCODE -ne 0 -or -not $linuxRoot) { throw 'Ubuntu WSL path conversion failed' }
if (-not (Get-CimInstance Win32_Process -Filter "Name = 'wsl.exe'" | Where-Object CommandLine -Match 'sleep infinity')) {
    Start-Process -FilePath 'C:/Windows/System32/wsl.exe' -ArgumentList @('-d','Ubuntu','--','sleep','infinity') -WindowStyle Hidden | Out-Null
}
$compose = "$linuxRoot/infra/compose.yaml"
& wsl -d Ubuntu -u root -- /usr/bin/docker compose -p order-review-demo -f $compose up -d
if ($LASTEXITCODE -ne 0) { throw 'ERPNext Compose startup failed' }
$ready = $false
for ($attempt=0; $attempt -lt 120; $attempt++) {
    $state = (& wsl -d Ubuntu -u root -- /usr/bin/docker inspect order-review-demo-create-site-1 --format '{{.State.Status}} {{.State.ExitCode}}').Trim()
    if ($state -eq 'exited 0') { $ready = $true; break }
    if ($state -like 'exited *') { throw "ERPNext site creation failed: $state. Inspect create-site logs." }
    Start-Sleep -Seconds 5
}
if (-not $ready) { throw 'ERPNext site creation exceeded 10 minutes' }
& wsl -d Ubuntu -u root -- /usr/bin/docker compose -p order-review-demo -f $compose cp "$linuxRoot/infra/seed.py" backend:/tmp/order-review-seed.py
if ($LASTEXITCODE -ne 0) { throw 'Could not copy seed.py' }
& wsl -d Ubuntu -u root -- /usr/bin/docker compose -p order-review-demo -f $compose cp "$linuxRoot/infra/seed-run.py" backend:/tmp/order-review-run.py
if ($LASTEXITCODE -ne 0) { throw 'Could not copy seed-run.py' }
'exec(open("/tmp/order-review-run.py").read())' | & wsl -d Ubuntu -u root -- /usr/bin/docker compose -p order-review-demo -f $compose exec -T backend bench --site frontend console
if ($LASTEXITCODE -ne 0) { throw 'ERPNext seed failed; inspect Python traceback' }
if (-not (Test-Path .env.erp)) {
    & wsl -d Ubuntu -u root -- /usr/bin/docker compose -p order-review-demo -f $compose cp backend:/tmp/order-review.env "$linuxRoot/.env.erp"
    if ($LASTEXITCODE -ne 0) { throw 'Could not save dedicated ERP API credentials' }
}
& wsl -d Ubuntu -u root -- /usr/bin/docker compose -p order-review-demo -f $compose exec -T backend rm -f /tmp/order-review.env
Write-Host 'Local ERPNext demo is ready on http://127.0.0.1:8080. API credentials are in ignored .env.erp.'
