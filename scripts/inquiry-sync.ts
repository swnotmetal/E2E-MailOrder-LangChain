// Frappe owns mail intake (Email Account -> Communication + Lead, deduplicated by Message-ID).
// This creates the review record a human works, with the AI draft reply already attached.
import { resolve } from 'node:path';
import { FrappeERP } from '../src/erp.js';
import { geminiInquiryReply } from '../src/model.js';
import { type InquiryCase } from '../src/domain.js';

for (const file of ['.env.erp', '.env']) {
  try {
    process.loadEnvFile(resolve(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
const inbox = process.env.ERP_INBOX_TOKEN;
if (!inbox) throw Error('ERP_INBOX_TOKEN missing from .env.erp (regenerate with frappe.core.doctype.user.user.generate_keys)');
if (!process.env.GOOGLE_API_KEY) throw Error('GOOGLE_API_KEY missing from .env');
const erp = new FrappeERP(process.env.ERP_URL ?? 'http://127.0.0.1:8080', `token ${inbox}`, process.env.ERP_COMPANY ?? 'Nordic Parts Demo');
const draftReply = geminiInquiryReply(resolve(process.env.ORDER_DATA_DIR ?? 'data'));
const html = (text: string) => `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`;

type Lead = { name: string; email_id?: string; lead_name?: string };
type Mail = { name: string; subject?: string; content?: string; text_content?: string; message_id?: string };

const filed = new Set(
  (await erp.list<{ source_message_id?: string }>('Inquiry', ['source_message_id'])).map(row => row.source_message_id)
);
let created = 0;
for (const lead of await erp.list<Lead>('Lead', ['name', 'email_id', 'lead_name'])) {
  const mails = await erp.list<Mail>('Communication', ['name', 'subject', 'content', 'text_content', 'message_id'], [
    ['reference_doctype', '=', 'Lead'],
    ['reference_name', '=', lead.name],
    ['sent_or_received', '=', 'Received'],
  ]);
  for (const mail of mails) {
    // The message id is the identity: without it there is nothing safe to deduplicate on.
    if (!mail.message_id || filed.has(mail.message_id)) continue;
    // A failed model call must not swallow the mail: the Inquiry is still created, just without a draft.
    let reply = '';
    try {
      const draft = await draftReply({
        intent: 'inquiry', customerText: mail.text_content ?? '', senderName: lead.lead_name ?? '', customer: '',
        lines: [], condition: '', requestedDate: '', deliveryAddress: '', needs: [], replyLanguage: '', responseDraft: '',
      } as InquiryCase);
      reply = draft.draft;
    } catch (error) {
      console.error(`draft reply failed for ${mail.message_id}: ${(error as Error).message}`);
    }
    await erp.request('/api/resource/Inquiry', {
      doctype: 'Inquiry',
      subject: mail.subject ?? '(no subject)',
      sender: lead.email_id ?? '',
      body: mail.content ?? '',
      suggested_reply: reply ? html(reply) : '',
      lead: lead.name,
      source_message_id: mail.message_id,
    });
    filed.add(mail.message_id);
    created += 1;
    console.log(`Inquiry filed for ${lead.name} <- ${mail.message_id} (reply: ${reply ? 'drafted' : 'none'})`);
  }
}
console.log(`${created} new Inquiry record(s)`);
