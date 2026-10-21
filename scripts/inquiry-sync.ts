// Turns natively received mail into the record a human edits and decides on.
//
// Frappe owns intake: the Email Account pulls over IMAP and creates a Communication
// (deduplicated by Message-ID) plus a Lead for an unknown sender. This script runs the same
// LangGraph pipeline the CLI uses, so the reviewer gets the model's extraction, the per-line ERP
// resolution, and a draft reply — then files a draft Quotation once they Qualify.
//
// Every ERP write the graph could make is disabled here: the review surface is the Inquiry, so a
// mail must not silently become an order or a work item on this path.
import { resolve } from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { FrappeERP, type ERP } from '../src/erp.js';
import { workflow } from '../src/workflow.js';
import { geminiExtractor, geminiInquiryReply } from '../src/model.js';
import { screenSolicitation } from '../src/triage.js';
import { type InquiryLine, type Source } from '../src/domain.js';

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
const dataDir = resolve(process.env.ORDER_DATA_DIR ?? 'data');
const draftReply = geminiInquiryReply(dataDir);
const html = (text: string) => `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`;
const strip = (value: string) => value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

type Lead = { name: string; email_id?: string; lead_name?: string };
type Mail = { name: string; subject?: string; content?: string; text_content?: string; message_id?: string };
type InquiryRow = { name: string; lead?: string; customer?: string; quotation?: string; lines?: { item?: string; quantity?: string }[] };

// Reads pass through; every write is refused, because this path files an Inquiry instead.
const reading: ERP = {
  findCustomers: (text) => erp.findCustomers(text),
  findItems: (text) => erp.findItems(text),
  inventory: (code) => erp.inventory(code),
  addresses: (customer) => erp.addresses(customer),
  duplicates: (draft) => erp.duplicates(draft),
  reviewState: (key) => erp.reviewState(key),
  createDraft: async () => ({ name: '(not written by inquiry sync)', docstatus: 0 }),
  createCustomer: async () => ({ name: '(not created by inquiry sync)' }),
  suggestReply: async () => ({ name: '(not filed: the review surface is the Inquiry)', communication: '' }),
};

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
    const body = (mail.text_content ?? '').trim() || strip(mail.content ?? '');
    // Pre-screen first: a vendor/recruitment pitch is filed for a human but never reaches a model,
    // so it costs no tokens and produces no reply draft.
    const screen = screenSolicitation(`${mail.subject ?? ''}\n${body}`);
    if (screen.solicitation) {
      const scrubbed = await erp.request<{ name: string }>('/api/resource/Inquiry', {
        doctype: 'Inquiry', subject: mail.subject ?? '(no subject)', sender: lead.email_id ?? '',
        body: mail.content ?? '', lead: lead.name, source_message_id: mail.message_id,
        screening: screen.reason,
      });
      // Through the workflow, not by writing the state: Frappe rejects a document saved straight
      // into a state it cannot reach by a transition.
      await erp.request('/api/method/frappe.model.workflow.apply_workflow', {
        doc: JSON.stringify({ doctype: 'Inquiry', name: scrubbed.name }), action: 'Screen',
      });
      filed.add(mail.message_id);
      created += 1;
      console.log(`Screened out ${mail.message_id}: ${screen.reason}`);
      continue;
    }
    const sources: Source[] = [
      { source: 'email', page: 0, text: body },
      ...(mail.subject ? [{ source: 'subject' as const, page: 0, text: mail.subject }] : []),
      ...(lead.email_id ? [{ source: 'sender' as const, page: 0, text: lead.email_id }] : []),
    ];

    // A failure anywhere in the pipeline must not swallow the mail: the Inquiry is still filed,
    // with whatever was resolved, so a human can finish the job by hand.
    let lines: InquiryLine[] = [];
    let reply = '';
    let purchaseOrder = '';
    let customer = '';
    let note = '';
    const saver = SqliteSaver.fromConnString(':memory:');
    try {
      const graph = workflow(reading, saver, geminiExtractor(dataDir), draftReply);
      const config = { configurable: { thread_id: mail.message_id } };
      await graph.invoke({ sources }, config);
      const values = (await graph.getState(config)).values;
      lines = values.availability ?? [];
      reply = values.inquiry?.responseDraft ?? '';
      purchaseOrder = values.draft?.po ?? values.extracted?.facts?.po?.[0]?.value ?? '';
      const written = values.extracted?.facts?.customer?.[0]?.value ?? '';
      // Exact-name match only. A near match is a human decision, not a guess.
      const matches = written ? await erp.findCustomers(written) : [];
      const exact = matches.filter(m => m.customer_name === written || m.name === written);
      customer = exact.length === 1 ? exact[0].name : '';
      if (written && !customer) note = `Sender "${written}" does not match an ERP customer exactly.`;
    } catch (error) {
      note = `Pipeline failed: ${(error as Error).message}`;
      console.error(`inquiry sync failed for ${mail.message_id}: ${(error as Error).message}`);
    } finally {
      saver.db.close();
    }

    // Fallback: mail the model routes to the order path produces no inquiry draft, but the
    // reviewer still needs something to send. Draft one directly from the body instead.
    if (!reply) {
      try {
        reply = (await draftReply({
          intent: 'inquiry', customerText: body, senderName: lead.lead_name ?? '', customer,
          lines: [], condition: '', requestedDate: '', deliveryAddress: '', needs: [], replyLanguage: '', responseDraft: '',
        })).draft.trim();
      } catch (error) {
        note = [note, `reply draft failed: ${(error as Error).message}`].filter(Boolean).join(' | ');
      }
    }

    await erp.request('/api/resource/Inquiry', {
      doctype: 'Inquiry',
      subject: mail.subject ?? '(no subject)',
      sender: lead.email_id ?? '',
      body: mail.content ?? '',
      suggested_reply: reply ? html(reply) : '',
      purchase_order: purchaseOrder,
      customer,
      lead: lead.name,
      source_message_id: mail.message_id,
      lines: lines.map(line => ({
        description: line.itemText ?? '',
        item: line.itemCode ?? '',
        quantity: line.quantity ?? '',
        uom: '',
        stock: line.inventory?.totalActualQty ?? 0,
        status: line.status,
      })),
    });
    filed.add(mail.message_id);
    created += 1;
    if (note) console.log(`note (${mail.message_id}): ${note}`);
    console.log(`Inquiry filed for ${lead.name} <- ${mail.message_id} (${lines.length} line(s), reply: ${reply ? 'drafted' : 'none'})`);
  }
}

// Qualify means "we will quote this". Only lines that resolved to a real item can be quoted; the
// rest stay for the reviewer to fix in the ERP before the quotation is sent.
const qualified = await erp.list<InquiryRow>('Inquiry', ['name'], [['workflow_state', '=', 'Qualified']]);
for (const row of qualified) {
  // Fetch the document itself: a list query with child fields flattens one row per child line
  // and does not give back the child table as an array.
  const inquiry = await erp.request<InquiryRow>(`/api/resource/Inquiry/${encodeURIComponent(row.name)}`);
  if (inquiry.quotation) continue;
  const items = (inquiry.lines ?? [])
    .filter(line => line.item && Number(line.quantity) > 0)
    .map(line => ({ item_code: line.item, qty: Number(line.quantity) }));
  if (!items.length) {
    console.log(`skip ${inquiry.name}: no quotable line`);
    continue;
  }
  // A Lead is a valid quotation party in ERPNext, so no Customer is invented to make this work.
  const quotation = await erp.request<{ name: string }>('/api/resource/Quotation', {
    doctype: 'Quotation',
    quotation_to: inquiry.customer ? 'Customer' : 'Lead',
    party_name: inquiry.customer || inquiry.lead,
    transaction_date: new Date().toISOString().slice(0, 10),
    items,
  });
  // ponytail: written after the create, so a crash in between can produce a second quotation;
  // the Inquiry's `quotation` field is what makes a repeat run skip it.
  await erp.request(`/api/resource/Inquiry/${encodeURIComponent(inquiry.name)}`, { quotation: quotation.name }, 'PUT');
  console.log(`Quotation ${quotation.name} filed for ${inquiry.name}`);
}

console.log(`${created} new Inquiry record(s)`);
