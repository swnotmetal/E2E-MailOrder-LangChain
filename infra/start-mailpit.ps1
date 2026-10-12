# Starts the local Mailpit SMTP server and web inbox, downloading the binary on first use.
# Mailpit is a local development inbox, not a mail provider. Everything stays on localhost.
param(
  [int]$SmtpPort = 1025,
  [int]$HttpPort = 8025
)
$ErrorActionPreference = 'Stop'
$dir = Join-Path $PSScriptRoot '.mailpit'
$exe = Join-Path $dir 'mailpit.exe'

if (-not (Test-Path $exe)) {
  Write-Host "Downloading the Mailpit release binary into $dir ..."
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $zip = Join-Path $dir 'mailpit.zip'
  Invoke-WebRequest -Uri 'https://github.com/axllent/mailpit/releases/latest/download/mailpit-windows-amd64.zip' -OutFile $zip -UseBasicParsing
  Expand-Archive $zip -DestinationPath $dir -Force
  Remove-Item $zip -Force
}

Write-Host "SMTP on 127.0.0.1:$SmtpPort  |  web inbox on http://127.0.0.1:$HttpPort"
& $exe --smtp "127.0.0.1:$SmtpPort" --listen "127.0.0.1:$HttpPort"
