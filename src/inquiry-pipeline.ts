// The pipeline that turns natively received mail into the record a human reviews.
//
// Frappe owns intake: the Email Account pulls over IMAP and creates a Communication (deduplicated
// by Message-ID) plus a Lead for an unknown sender. This module reads what Frappe created, runs the
// per-mail processing it is given, and files exactly one Inquiry — then drafts a Quotation once a
// human moves that Inquiry to Qualified.
//
// It takes its ERP, its per-mail processing and its log sink as arguments on purpose: that is what
// makes the whole pipeline testable without a live site, a model call, or a network.
import { type InquiryLine, type Source } from './domain.js';
import { type Log, log as defaultLog } from './log.js';
import { screenSolicitation } from './triage.js';

export type PipelineErp = {
  list<T>(doctype: string, fields: string[], filters?: unknown[]): Promise<T[]>;
  request<T>(path: string, body?: unknown, method?: 'POST' | 'PUT'): Promise<T>;
  findCustomers(text: string): Promise<{ name: string; customer_name: string }[]>;
};

export type MailResult = {
  lines: InquiryLine[];
  reply: string;
  purchaseOrder: string;
  customerText: string;
};

export type ProcessMail = (sources: Source[], threadId: string) => Promise<MailResult>;

export type MailContext = { subject: string; body: string; senderEmail: string; senderName: string };
export type DraftReply = (mail: MailContext, customer: string) => Promise<string>;

export type SyncSummary = { screened: number; filed: number; quotations: number };

type Lead = { name: string; email_id?: string; lead_name?: string };
type Mail = { name: string; subject?: string; content?: string; text_content?: string; message_id?: string };
type InquiryRow = {
  name: string;
  lead?: string;
  customer?: string;
  quotation?: string;
  lines?: { item?: string; quantity?: string }[];
};

const html = (text: string) =>
  `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`;
const strip = (value: string) => value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

export async function runInquirySync(deps: {
  erp: PipelineErp;
  processMail: ProcessMail;
  draftReply: DraftReply;
  log?: Log;
}): Promise<SyncSummary> {
  const { erp, processMail, draftReply } = deps;
  const log = deps.log ?? defaultLog;

  // The message id is the identity: without it there is nothing safe to deduplicate on.
  const filed = new Set(
    (await erp.list<{ source_message_id?: string }>('Inquiry', ['source_message_id']))
      .map(row => row.source_message_id)
      .filter((id): id is string => Boolean(id)),
  );
  const summary: SyncSummary = { screened: 0, filed: 0, quotations: 0 };

  for (const lead of await erp.list<Lead>('Lead', ['name', 'email_id', 'lead_name'])) {
    const mails = await erp.list<Mail>('Communication', ['name', 'subject', 'content', 'text_content', 'message_id'], [
      ['reference_doctype', '=', 'Lead'],
      ['reference_name', '=', lead.name],
      ['sent_or_received', '=', 'Received'],
    ]);
    for (const mail of mails) {
      if (!mail.message_id || filed.has(mail.message_id)) continue;
      const messageId = mail.message_id;
      const subject = mail.subject ?? '';
      const body = (mail.text_content ?? '').trim() || strip(mail.content ?? '');

      // Pre-screen first: a vendor or recruitment pitch is filed for a human but never reaches a
      // model, so it costs no tokens and produces no reply draft.
      const screen = screenSolicitation(`${subject}\n${body}`);
      if (screen.solicitation) {
        const scrubbed = await erp.request<{ name: string }>('/api/resource/Inquiry', {
          doctype: 'Inquiry', subject: subject || '(no subject)', sender: lead.email_id ?? '',
          body: mail.content ?? '', lead: lead.name, source_message_id: messageId,
          screening: screen.reason,
        });
        // Through the workflow, not by writing the state: Frappe rejects a document saved straight
        // into a state it cannot reach by a transition.
        await erp.request('/api/method/frappe.model.workflow.apply_workflow', {
          doc: JSON.stringify({ doctype: 'Inquiry', name: scrubbed.name }), action: 'Screen',
        });
        filed.add(messageId);
        summary.screened += 1;
        log('inquiry.screened_out', { message_id: messageId, inquiry: scrubbed.name, reason: screen.reason });
        continue;
      }

      const sources: Source[] = [
        { source: 'email', page: 0, text: body },
        ...(subject ? [{ source: 'subject' as const, page: 0, text: subject }] : []),
        ...(lead.email_id ? [{ source: 'sender' as const, page: 0, text: lead.email_id }] : []),
      ];

      // A failure anywhere in the pipeline must not swallow the mail: the Inquiry is still filed,
      // with whatever was resolved, so a human can finish the job by hand.
      let result: MailResult = { lines: [], reply: '', purchaseOrder: '', customerText: '' };
      let note = '';
      try {
        result = await processMail(sources, messageId);
      } catch (error) {
        note = `Pipeline failed: ${(error as Error).message}`;
        log('inquiry.pipeline_failed', { message_id: messageId, error: (error as Error).message });
      }

      // Exact-name match only. A near match is a human decision, not a guess.
      let customer = '';
      if (result.customerText) {
        const matches = await erp.findCustomers(result.customerText);
        const exact = matches.filter(m => m.customer_name === result.customerText || m.name === result.customerText);
        customer = exact.length === 1 ? exact[0].name : '';
        if (!customer) note = [note, `Sender "${result.customerText}" does not match an ERP customer exactly.`]
          .filter(Boolean).join(' | ');
      }

      // Fallback: mail the model routes to the order path produces no inquiry draft, but the
      // reviewer still needs something to send. Draft one directly from the body instead.
      let reply = result.reply;
      if (!reply) {
        try {
          const context: MailContext = {
            subject, body, senderEmail: lead.email_id ?? '', senderName: lead.lead_name ?? '',
          };
          reply = (await draftReply(context, customer)).trim();
        } catch (error) {
          note = [note, `reply draft failed: ${(error as Error).message}`].filter(Boolean).join(' | ');
        }
      }

      const inquiry = await erp.request<{ name: string }>('/api/resource/Inquiry', {
        doctype: 'Inquiry',
        subject: subject || '(no subject)',
        sender: lead.email_id ?? '',
        body: mail.content ?? '',
        suggested_reply: reply ? html(reply) : '',
        purchase_order: result.purchaseOrder,
        customer,
        lead: lead.name,
        source_message_id: messageId,
        lines: result.lines.map(line => ({
          description: line.itemText ?? '',
          item: line.itemCode ?? '',
          quantity: line.quantity ?? '',
          uom: '',
          stock: line.inventory?.totalActualQty ?? 0,
          status: line.status,
        })),
      });
      filed.add(messageId);
      summary.filed += 1;
      if (note) log('inquiry.note', { message_id: messageId, note });
      log('inquiry.filed', {
        message_id: messageId, inquiry: inquiry.name, lead: lead.name,
        lines: result.lines.length, reply: Boolean(reply), customer: customer || null,
      });
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
      log('inquiry.quotation_skipped', { inquiry: inquiry.name, reason: 'no quotable line' });
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
    // Written after the create, so a crash in between can produce a second quotation; the
    // Inquiry's `quotation` field is what makes a repeat run skip it.
    await erp.request(`/api/resource/Inquiry/${encodeURIComponent(inquiry.name)}`, { quotation: quotation.name }, 'PUT');
    summary.quotations += 1;
    log('inquiry.quotation', { inquiry: inquiry.name, quotation: quotation.name, items: items.length });
  }

  return summary;
}
