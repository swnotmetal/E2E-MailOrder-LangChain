# One command for the whole local loop, Windows side. Wraps the pieces instead of repeating them:
#   1. start the ERP            (idempotent: a running stack comes up fast)
#   2. install the Inquiry UI   (idempotent)
#   3. send every file in test/mails to GreenMail over SMTP
#   4. ask the ERP's Email Account to pull over IMAP
#   5. file the Inquiries / draft the Quotations
# Step 5 is the only one that calls a model, so a failure before it costs nothing.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

function Step([string]$label, [scriptblock]$action) {
  Write-Host "`n=== $label ===" -ForegroundColor Cyan
  try { & $action } catch {
    Write-Host "FAILED: $label`n$($_.Exception.Message)" -ForegroundColor Red
    exit 1
  }
  if ($LASTEXITCODE) {
    Write-Host "FAILED: $label (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
  }
}

Step 'Start the ERP' { & (Join-Path $PSScriptRoot 'start-wsl.ps1') }
Step 'Install the Inquiry surface' { & (Join-Path $PSScriptRoot 'seed-inquiry.ps1') }
Step 'Send test mails to GreenMail' {
  $env:MAILPIT_SMTP = '127.0.0.1:3025'
  npm run --silent mail:tests
}
Step 'Pull mail into ERPNext' {
  $linuxRoot = (wsl -d Ubuntu -- wslpath -a $root).Trim()
  wsl -d Ubuntu -u root -- /usr/bin/docker compose -p order-review-demo -f "$linuxRoot/infra/compose.yaml" `
    exec -T -w /home/frappe/frappe-bench backend `
    bench --site frontend execute frappe.email.doctype.email_account.email_account.pull
}
Step 'File Inquiries from that mail' { npm run --silent inquiry:sync }

Write-Host "`nDone. Review in ERPNext: http://127.0.0.1:8080/app/inquiry" -ForegroundColor Green
