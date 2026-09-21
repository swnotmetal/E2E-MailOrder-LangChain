$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$composeArgs = @('compose','-p','order-review-demo','-f','infra/compose.yaml')
& docker info --format '{{.ServerVersion}}'
if ($LASTEXITCODE -ne 0) { throw 'Docker Linux engine is unavailable. Enable virtualization/Virtual Machine Platform and restart first.' }
& docker @composeArgs up -d
if ($LASTEXITCODE -ne 0) { throw 'Compose startup failed' }
Write-Host 'Waiting up to 10 minutes for the ERPNext site (first startup downloads images and initializes MariaDB).'
$ready = $false
for ($attempt=0; $attempt -lt 120; $attempt++) {
    try { $response=Invoke-WebRequest http://127.0.0.1:8080/api/method/ping -TimeoutSec 3; if($response.StatusCode -eq 200) {$ready=$true;break} } catch {}
    Start-Sleep -Seconds 5
}
if (-not $ready) { throw 'ERP not ready. Inspect: docker compose -p order-review-demo -f infra/compose.yaml logs create-site' }
& docker @composeArgs cp infra/seed.py backend:/tmp/order-review-seed.py
if ($LASTEXITCODE -ne 0) { throw 'Could not copy seed script' }
'exec(open("/tmp/order-review-seed.py").read())' | & docker @composeArgs exec -T backend bench --site frontend console
if ($LASTEXITCODE -ne 0) { throw 'Seed failed; inspect output' }
if (Test-Path .env.erp) { throw 'Preserved existing .env.erp. Verify its API credentials before replacing it.' }
& docker @composeArgs cp backend:/tmp/order-review.env .env.erp
if ($LASTEXITCODE -ne 0) { throw 'Seed did not produce credentials; inspect the console output' }
& docker @composeArgs exec -T backend rm -f /tmp/order-review.env
Write-Host 'ERP ready at http://127.0.0.1:8080. Dedicated demo only; default UI login is Administrator/admin. API credential is in ignored .env.erp.'

