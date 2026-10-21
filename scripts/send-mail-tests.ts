// Stands in for external senders: splits test/mail-tests.txt into messages and posts each one over
// real SMTP into the local mailbox, so the ERP's own inbox can pick them up.
import { readFile } from 'node:fs/promises';
import { createTransport } from 'nodemailer';

const source = process.argv[2] ?? 'test/mail-tests.txt';
const endpoint = process.env.MAILPIT_SMTP ?? '127.0.0.1:1025';
const [host, port] = endpoint.split(':');

const text = await readFile(source, 'utf8');
// Blocks are separated by a line of three or more dashes, but a hand-edited file often loses one.
// Every message starts with `From:`, so also split there: a missing separator then still yields
// one message per sender instead of two senders merged into one garbled mail.
const blocks = text
  .split(/^\s*-{3,}\s*$/m)
  .flatMap(part => part.split(/^(?=From:)/m))
  .map(block => block.trim())
  .filter(Boolean);
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
  // Never claim a specific product: the same SMTP endpoint can be Mailpit (:1025) or GreenMail (:3025),
  // and telling someone to open the Mailpit inbox after sending to GreenMail wastes their time.
  const greenMail = Number(port) === 3025;
  console.log(`\n${messages.length} messages delivered over SMTP to ${endpoint}`);
  console.log(greenMail
    ? 'This is GreenMail, the IMAP mailbox the ERP pulls from. Nothing appears in Mailpit. Next:\n  bench --site frontend execute frappe.email.doctype.email_account.email_account.pull\n  npm run inquiry:sync'
    : 'This is Mailpit. It has no IMAP, so the ERP cannot pull from it. Read it at http://127.0.0.1:8025');
} finally {
  transport.close();
}
