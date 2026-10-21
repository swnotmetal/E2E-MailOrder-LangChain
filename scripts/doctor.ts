// `npm run doctor` — answers "why won't it run" in one command.
//
// Every check is read-only, and nothing here calls a model: the point is to find the broken layer
// before a run spends money or writes a record. Fatal checks stop the mail path; the rest are
// warnings, because the demo can still be inspected without them.
import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { erpConfig, loadEnvFiles, modelConfig } from '../src/config.js';
import { FrappeERP } from '../src/erp.js';

type Status = 'ok' | 'WARN' | 'FAIL';
const results: { status: Status; check: string; detail: string }[] = [];
const record = (status: Status, check: string, detail: string) => results.push({ status, check, detail });

function probe(host: string, port: number, timeoutMs = 1500): Promise<string> {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    const done = (detail: string) => { socket.destroy(); resolve(detail); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done('open'));
    socket.once('timeout', () => done('timed out'));
    socket.once('error', error => done((error as NodeJS.ErrnoException).code ?? 'error'));
  });
}

loadEnvFiles();

for (const file of ['.env.erp', '.env']) {
  if (existsSync(file)) record('ok', `env file ${file}`, 'present');
  else record('WARN', `env file ${file}`, 'missing (only needed for the ERP / mail path)');
}

let settings: ReturnType<typeof erpConfig> | null = null;
try {
  settings = erpConfig();
  record('ok', 'ERP config', `${settings.base} as ${settings.company}`);
} catch (error) {
  record('FAIL', 'ERP config', (error as Error).message);
}

try {
  modelConfig();
  record('ok', 'model config', 'GOOGLE_API_KEY present (not called: that would spend a request)');
} catch (error) {
  record('FAIL', 'model config', (error as Error).message);
}

if (settings) {
  const erp = new FrappeERP(settings.base, `token ${settings.token}`, settings.company);
  try {
    const res = await fetch(new URL('/api/method/ping', settings.base), { signal: AbortSignal.timeout(4000) });
    const body = (await res.json()) as { message?: string };
    record(res.ok ? 'ok' : 'FAIL', 'ERP reachable', `${settings.base} responded ${body.message ?? res.status}`);
  } catch (error) {
    record('FAIL', 'ERP reachable', `${settings.base}: ${(error as Error).message}`);
  }

  try {
    const inquiries = await erp.list<{ name: string }>('Inquiry', ['name']);
    record('ok', 'token + Inquiry DocType', `${inquiries.length} Inquiry record(s) visible`);
  } catch (error) {
    record('FAIL', 'token + Inquiry DocType', (error as Error).message);
  }

  try {
    const leads = await erp.list<{ name: string }>('Lead', ['name']);
    const mails = await erp.list<{ name: string }>('Communication', ['name'], [
      ['reference_doctype', '=', 'Lead'], ['sent_or_received', '=', 'Received'],
    ]);
    record('ok', 'mail intake visible', `${leads.length} Lead(s), ${mails.length} received mail(s)`);
  } catch (error) {
    record('WARN', 'mail intake visible', (error as Error).message);
  }
}

for (const [label, port] of [['GreenMail SMTP', 3025], ['GreenMail IMAP', 3143]] as const) {
  const detail = await probe('127.0.0.1', port);
  record(detail === 'open' ? 'ok' : 'WARN', label, `127.0.0.1:${port} ${detail}`);
}

const width = Math.max(...results.map(r => r.check.length));
for (const { status, check, detail } of results) {
  process.stdout.write(`${status.padEnd(4)}  ${check.padEnd(width)}  ${detail}\n`);
}

const fatal = results.filter(r => r.status === 'FAIL');
process.stdout.write(
  fatal.length
    ? `\n${fatal.length} blocking problem(s). Fix the FAIL lines first; WARN lines only affect the mail path.\n`
    : `\nReady. ${results.filter(r => r.status === 'WARN').length} warning(s), nothing blocking.\n`,
);
process.exit(fatal.length ? 1 : 0);
