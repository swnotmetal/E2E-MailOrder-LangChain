import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeMail } from '../src/mime.js';
import { readSources, templateExtractor, verifyEvidence } from '../src/input.js';

// Hand-written MIME so the decoder is exercised independently of whatever wrote the message.
async function rawMessage() {
  const pdf = await readFile('fixtures/01-clean.pdf');
  const base64 = pdf.toString('base64').replace(/(.{76})/g, '$1\r\n');
  return [
    'From: "Muller Auto Service Garage" <lucas.weber@example.invalid>',
    'To: sales@example.invalid',
    `Subject: =?UTF-8?B?${Buffer.from('Fiktive Bestellung', 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="outer"',
    '',
    '--outer',
    'Content-Type: multipart/alternative; boundary="inner"',
    '',
    '--inner',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Customer: Acme Workshop',
    'PO: DEMO-900',
    'Delivery: 2027-03-01',
    'Address: 10 Test Road, Helsinki, 00100, Finland',
    'Item: FILTER-A10 | 5 | Nos',
    '',
    'Total price is 100=E2=82=AC per unit, please confir=',
    'm availability.',
    '',
    '--inner',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '<p>Customer: Acme Workshop</p>',
    '',
    '--inner--',
    '',
    '--outer',
    'Content-Type: application/pdf; name="order.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="order.pdf"',
    '',
    base64,
    '',
    '--outer--',
    ''
  ].join('\r\n');
}

test('MIME decoding reads the text body, header address and PDF attachment', async () => {
  const decoded = await decodeMail(Buffer.from(await rawMessage(), 'utf8'));
  assert.equal(decoded.from, 'lucas.weber@example.invalid');
  assert.equal(decoded.subject, 'Fiktive Bestellung');
  assert.match(decoded.text, /100€ per unit, please confirm availability\./);
  assert.doesNotMatch(decoded.text, /=\r?\n/);
  assert.doesNotMatch(decoded.text, /Content-Type|<p>|boundary/);
  assert.equal(decoded.pdfs.length, 1);
  assert.equal(decoded.pdfs[0].filename, 'order.pdf');
  assert.equal(decoded.pdfs[0].content.subarray(0, 4).toString(), '%PDF');
});

test('readSources decodes MIME mail and keeps header identity out of the prose', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mime-mail-'));
  const file = join(dir, 'message.eml');
  await writeFile(file, await rawMessage());
  try {
    const sources = await readSources(file);
    assert.deepEqual(sources.map(source => [source.source, source.page]), [['email', 0], ['pdf', 1]]);
    assert.match(sources[0].text, /Customer: Acme Workshop/);
    // The From address and the sender company live in headers only, so prose extraction
    // can never fabricate them; a real mailbox should read them from MIME instead.
    assert.doesNotMatch(sources[0].text, /lucas\.weber@example\.invalid|Muller Auto Service Garage/);
    const extraction = await templateExtractor(sources);
    verifyEvidence(extraction, sources);
    assert.equal(extraction.facts.po.length, 2);
    assert.equal(extraction.lines.length, 2);
    assert.equal(extraction.facts.date[0].value, '2027-03-01');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('plain UTF-8 fixtures are still read verbatim, including their headers', async () => {
  const sources = await readSources('fixtures/01-clean.eml', 'fixtures/01-clean.pdf');
  assert.deepEqual(sources.map(source => [source.source, source.page]), [['email', 0], ['pdf', 1]]);
  assert.match(sources[0].text, /^From: buyer@example\.invalid/);
  const extraction = await templateExtractor(sources);
  verifyEvidence(extraction, sources);
  assert.equal(extraction.facts.po.length, 2);
});
