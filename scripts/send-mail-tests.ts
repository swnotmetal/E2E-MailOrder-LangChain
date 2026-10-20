// Stands in for external senders: splits test/mail-tests.txt into messages and posts each one over
// real SMTP into the local mailbox, so the ERP's own inbox can pick them up.
import { readFile } from 'node:fs/promises';
import { createTransport } from 'nodemailer';

const source = process.argv[2] ?? 'test/mail-tests.txt';
const endpoint = process.env.MAILPIT_SMTP ?? '127.0.0.1:1025';
const [host, port] = endpoint.split(':');

const text = await readFile(source, 'utf8');
// Blocks are separated by a line of three or more dashes.
const blocks = text.split(/^\s*-{3,}\s*$/m).map(block => block.trim()).filter(Boolean);
if (!blocks.length) throw Error('NO_MESSAGES: expected blocks separated by a line of dashes');

const messages = blocks.map((block, index) => {
  // Headers end at the first line that is not itself a header. That is normally the blank line,
  // but hand-written test files often omit it, so a missing blank line is tolerated rather than
  // rejected: the first prose line simply marks where the body starts.
  const lines = block.split(/\r?\n/);
  const headerEnd = lines.findIndex(line => !/^[A-Za-z][A-Za-z-]*:/.test(line));
  if (headerEnd === -1) throw Error(`NO_BODY: message ${index + 1} has headers but no body`);
  const headers = lines.slice(0, headerEnd);
  const header = (name: string) =>
    headers.find(line => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))?.slice(name.length + 1).trim() ?? '';
  if (!header('From') || !header('To') || !header('Subject')) {
    throw Error(`INCOMPLETE_HEADERS: message ${index + 1} needs From, To and Subject`);
  }
  // The block's own headers are transport metadata and must never be re-sent inside the body.
  return { from: header('From'), to: header('To'), subject: header('Subject'),
    body: lines.slice(headerEnd).join('\n').replace(/^\r?\n/, '') };
});

const transport = createTransport({ host, port: Number(port), secure: false, ignoreTLS: true });
try {
  for (const mail of messages) {
    const info = await transport.sendMail({ from: mail.from, to: mail.to, subject: mail.subject, text: mail.body });
    console.log(`Sent "${mail.subject}" from ${mail.from} (${info.messageId})`);
  }
  console.log(`\n${messages.length} messages delivered to Mailpit over SMTP (${endpoint})`);
  console.log('Read them at http://127.0.0.1:8025');
} finally {
  transport.close();
}
