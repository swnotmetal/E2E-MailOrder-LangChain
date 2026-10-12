// Bridges the local Mailpit inbox into the learning lab: polls Mailpit, pulls each new
// raw MIME message and hands it to the lab's localhost-only /api/ingest endpoint.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const lab = process.env.LEARN_BASE_URL?.trim() || 'http://127.0.0.1:3210';
const mailpit = process.env.MAILPIT_HTTP?.trim() || 'http://127.0.0.1:8025';
const mode = process.argv.includes('--gemini') ? 'gemini' : 'template';
const watch = process.argv.includes('--watch');
const stateDir = resolve('data/mailbox');
const statePath = resolve(stateDir, 'ingested.json');

type MailpitMessage = { ID: string; Subject: string; From?: { Address?: string } };

async function loadSeen(): Promise<Set<string>> {
  try {
    return new Set(JSON.parse(await readFile(statePath, 'utf8')) as string[]);
  } catch {
    return new Set();
  }
}

async function saveSeen(seen: Set<string>) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(statePath, JSON.stringify([...seen], null, 2));
}

async function ingestOnce(seen: Set<string>) {
  const listing = (await (await fetch(`${mailpit}/api/v1/messages`)).json()) as { messages: MailpitMessage[] };
  const pending = listing.messages.filter(message => !seen.has(message.ID));
  for (const message of pending) {
    const raw = Buffer.from(await (await fetch(`${mailpit}/api/v1/message/${message.ID}/raw`)).arrayBuffer());
    const response = await fetch(`${lab}/api/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: message.Subject, raw: raw.toString('base64'), mode })
    });
    const result = (await response.json()) as { status?: string; error?: string };
    const outcome = response.ok ? 'ok' : 'FAIL';
    console.log(`${outcome}  ${message.Subject}  from ${message.From?.Address ?? '?'}  ->  ${result.error ?? result.status ?? 'ingested'}`);
    if (response.ok) {
      seen.add(message.ID);
      await saveSeen(seen);
    }
  }
  return pending.length;
}

const seen = await loadSeen();
if (!watch) {
  const count = await ingestOnce(seen);
  if (!count) console.log('No new Mailpit messages.');
} else {
  console.log(`Watching ${mailpit} every 2s (mode: ${mode}). Ctrl+C to stop.`);
  for (;;) {
    await ingestOnce(seen).catch(error => console.error(`ingest failed: ${error instanceof Error ? error.message : error}`));
    await new Promise(settle => setTimeout(settle, 2000));
  }
}
