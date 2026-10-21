// Stands in for external senders: posts every file in test/mails over real SMTP, so the ERP's own
// inbox can pull them. One file per message, so adding or editing a mail can never merge two mails.
//
// A mail file is strict on purpose: three header lines in this exact order, one blank line, body.
// Anything else fails immediately with the file name and the offending line, instead of being
// guessed at.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createTransport } from 'nodemailer';

const source = process.argv[2] ?? 'test/mails';
const endpoint = process.env.MAILPIT_SMTP ?? '127.0.0.1:1025';
const [host, port] = endpoint.split(':');

const FIELDS = ['From', 'To', 'Subject'] as const;

async function mailFiles(): Promise<string[]> {
  if (source.endsWith('.txt')) return [source];
  const names = (await readdir(source)).filter(name => name.endsWith('.txt')).sort();
  if (!names.length) throw Error(`NO_MESSAGES: ${source} contains no .txt file`);
  return names.map(name => join(source, name));
}

function parse(file: string, raw: string) {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < FIELDS.length; index += 1) {
    const expected = `${FIELDS[index]}:`;
    const actual = (lines[index] ?? '').slice(0, expected.length);
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw Error(
        `${file}: line ${index + 1} must start with "${expected}", found "${lines[index] ?? ''}".\n` +
        'Expected format:\n  From: someone@example.com\n  To: sales@example.invalid\n  Subject: ...\n  <blank line>\n  body');
    }
  }
  if ((lines[3] ?? '').trim() !== '') {
    throw Error(`${file}: line 4 must be empty. The body starts on line 5; a value here usually means a stray header.`);
  }
  const field = (index: number) => lines[index].slice(FIELDS[index].length + 1).trim();
  const from = field(0), to = field(1), subject = field(2);
  for (const [name, value] of [['From', from], ['To', to]] as const) {
    if (!value.includes('@')) throw Error(`${file}: ${name} is not an address ("${value}")`);
  }
  const body = lines.slice(4).join('\n').trim();
  if (!body) throw Error(`${file}: body is empty`);
  return { from, to, subject, body };
}

const messages: { from: string; to: string; subject: string; body: string }[] = [];
for (const file of await mailFiles()) {
  messages.push(parse(file, await readFile(file, 'utf8')));
}

const transport = createTransport({ host, port: Number(port), secure: false, ignoreTLS: true });
try {
  for (const mail of messages) {
    const info = await transport.sendMail({ from: mail.from, to: mail.to, subject: mail.subject, text: mail.body });
    console.log(`Sent "${mail.subject}" from ${mail.from} (${info.messageId})`);
  }
  // Never claim a specific product: the same SMTP endpoint can be Mailpit (:1025) or GreenMail (:3025),
  // and telling someone to open the Mailpit inbox after sending to GreenMail wastes their time.
  const greenMail = Number(port) === 3025;
  console.log(`\n${messages.length} messages delivered over SMTP to ${endpoint}`);
  console.log(greenMail
    ? 'This is GreenMail, the IMAP mailbox the ERP pulls from. Nothing appears in Mailpit.\nUse `npm run demo` to pull them into ERPNext and file the Inquiries.'
    : 'This is Mailpit. It has no IMAP, so the ERP cannot pull from it. Read it at http://127.0.0.1:8025');
} finally {
  transport.close();
}
