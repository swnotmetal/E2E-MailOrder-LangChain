// One command for the whole local loop. Picks the right implementation for this host so the same
// `npm run demo` works in PowerShell and in a Linux container (Codespaces, CI, a VM).
import { spawnSync } from 'node:child_process';

const windows = process.platform === 'win32';
const run = windows
  ? spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'infra/demo.ps1'], { stdio: 'inherit' })
  : spawnSync('bash', ['infra/demo.sh'], { stdio: 'inherit' });

process.exit(run.status ?? 1);
