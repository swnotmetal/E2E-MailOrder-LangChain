// Stands in for an external customer: sends one fictional email plus a PDF attachment
// over real SMTP into the local Mailpit inbox.
import { readFile } from 'node:fs/promises';
import { createTransport } from 'nodemailer';

const fixture = process.argv[2] ?? '01-clean';
const endpoint = process.env.MAILPIT_SMTP ?? '127.0.0.1:1025';
const [host, port] = endpoint.split(':');

const mail = await readFile(`fixtures/${fixture}.eml`, 'utf8');
// Only the body is the customer's prose; the fixture's own RFC822 headers are transport
// metadata and must never be re-sent inside the body.
const separator = mail.search(/\r?\n\r?\n/);
const body = separator === -1 ? mail : mail.slice(separator).replace(/^\r?\n\r?\n/, '');
const attachment = await readFile(`fixtures/${fixture}.pdf`);

const transport = createTransport({ host, port: Number(port), secure: false, ignoreTLS: true });
try {
  const info = await transport.sendMail({
    from: `"Fictional Customer (${fixture})" <customer-${fixture}@example.invalid>`,
    to: 'sales@example.invalid',
    subject: `Fictional order ${fixture}`,
    text: body,
    attachments: [{ filename: `${fixture}.pdf`, content: attachment, contentType: 'application/pdf' }]
  });
  console.log(`Sent ${fixture} to Mailpit over SMTP (${endpoint})`);
  console.log(`Message id: ${info.messageId}`);
  console.log('View it at http://127.0.0.1:8025');
} finally {
  transport.close();
}
