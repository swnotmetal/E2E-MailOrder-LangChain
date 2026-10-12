import { simpleParser } from 'mailparser';

export type DecodedMail = {
  // Read from the MIME headers, never inferred from the body prose.
  from: string;
  subject: string;
  // Plain-text body used as the `email` source. Headers are deliberately excluded.
  text: string;
  pdfs: { filename: string; content: Buffer }[];
};

const pdfTypes = new Set(['application/pdf', 'application/x-pdf']);

function addressOf(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const list = (value as { value?: { address?: string }[] }).value;
  return list?.[0]?.address ?? '';
}

// Approximate only: used when a message carries HTML but no text/plain part.
function textFromHtml(html: string | false | undefined): string {
  if (typeof html !== 'string') return '';
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

export async function decodeMail(raw: Buffer | string): Promise<DecodedMail> {
  const parsed = await simpleParser(raw);
  const text = (parsed.text ?? textFromHtml(parsed.html)).trim();
  const pdfs = parsed.attachments
    .filter(attachment => pdfTypes.has((attachment.contentType ?? '').toLowerCase()) || /\.pdf$/i.test(attachment.filename ?? ''))
    .map(attachment => ({ filename: attachment.filename || 'attachment.pdf', content: attachment.content }));
  return { from: addressOf(parsed.from), subject: parsed.subject ?? '', text, pdfs };
}
