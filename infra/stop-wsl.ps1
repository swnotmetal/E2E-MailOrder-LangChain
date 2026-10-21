# Stops the local ERPNext containers while preserving the database, site files and seeded masters.
# This is the counterpart of start-wsl.ps1: same WSL distro, same compose project name, same file.
#
# Why this script exists: `docker compose` inside WSL needs a *Linux* path for -f, and this
# repository lives under a Windows path containing a space ("Langgraph project"). Converting the
# path and quoting it by hand on every stop is easy to get wrong, so it is done once here.
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $projectRoot
$linuxRoot = (& wsl -d Ubuntu -- wslpath -a $projectRoot).Trim()
if ($LASTEXITCODE -ne 0 -or -not $linuxRoot) { throw 'Ubuntu WSL path conversion failed' }

& wsl -d Ubuntu -u root -- /usr/bin/docker compose -p order-review-demo -f "$linuxRoot/infra/compose.yaml" stop
if ($LASTEXITCODE -ne 0) { throw 'compose stop failed' }

Write-Host 'ERPNext containers stopped. Data is preserved: run .\infra\start-wsl.ps1 to continue.'
