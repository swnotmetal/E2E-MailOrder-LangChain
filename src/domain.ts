import { z } from 'zod';
import { createHash } from 'node:crypto';

export const fields = ['customer', 'po', 'date', 'address'] as const;
export type Field = typeof fields[number];
export const factFields = [...fields, 'sender', 'location'] as const;
export type FactField = typeof factFields[number];
export type Evidence = { source: 'email' | 'subject' | 'sender' | 'pdf'; page: number; start: number; end: number; quote: string };
export type Fact = { value: string; evidence: Evidence };
export type Issue = { code: string; field: string; message: string };
export type Source = { source: 'email' | 'subject' | 'sender' | 'pdf'; page: number; text: string };
export type Extraction = { facts: Record<FactField, Fact[]>; lines: { description: Fact; quantity: Fact; unit: Fact }[];
  intent?:{kind:'purchase'|'inquiry'|'conditional'|'unclear';evidence:Fact}; reply?:{language:string}; traceId?:string; warnings?:Issue[] };
export type Customer = { name: string; customer_name: string };
export type Item = { name: string; item_name: string; stock_uom: string; disabled?: number };
export type Address = { name: string; text: string };
export type NewCustomer = { name: string; address?: string };
export type InquiryLine = {
  itemText:string; itemCode:string; quantity:string;
  status:'recorded-stock'|'out-of-stock'|'untracked'|'unresolved'|'catalog-miss'|'lookup-failed';
  inventory:{stockTracked:boolean;totalActualQty:number|null}|null;
};
export type InquiryCase = {
  intent:'inquiry'|'conditional'|'unclear'; customerText:string; senderName:string; customer:string;
  lines:InquiryLine[]; condition:string; requestedDate:string; deliveryAddress:string;
  needs:string[]; replyLanguage:string; responseDraft:string; replyTraceId?:string; replyModel?:string;
};
export const DraftSchema = z.object({
  customer: z.string(), po: z.string(), date: z.string(), address: z.string(),
  lines: z.array(z.object({ description: z.string(), item: z.string(), quantity: z.string(), unit: z.string() }).strict())
}).strict();
export type Draft = z.infer<typeof DraftSchema>;
export const DecisionSchema = z.object({
  action: z.enum(['approve', 'reject', 'request-info']), revision: z.string(),
  actor: z.string().trim().min(1), reason: z.string(), draft: DraftSchema, confirmPurchase:z.boolean().optional(),
  newCustomer: z.object({ name: z.string().trim().min(1), address: z.string().trim().optional() }).optional(),
  customerNote: z.string().trim().optional()
}).strict();
export type Decision = z.infer<typeof DecisionSchema>;
export const InquiryDecisionSchema=z.object({
  action:z.enum(['approve-reply','request-info','close']),revision:z.string(),actor:z.string().trim().min(1),
  reason:z.string(),responseDraft:z.string().trim().optional()
}).strict();
export type InquiryDecision=z.infer<typeof InquiryDecisionSchema>;
// The only decision the application accepts is one the ERP already recorded: a human submitted the
// draft, or cancelled it. `actor` comes from ERPNext's `modified_by`, so the audit names the person
// who acted rather than accepting a name typed into a form.
export const ErpReviewDecisionSchema=z.object({
  action:z.enum(['approve','reject']),revision:z.string(),actor:z.string().trim().min(1),
  reason:z.string(),source:z.literal('erpnext'),erpDocument:z.string().trim().min(1)
}).strict();
export type ErpReviewDecision=z.infer<typeof ErpReviewDecisionSchema>;
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const normalize = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
export const orderKey = (d: Draft) => digest([d.customer, normalize(d.po)]);
export function validDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s;
}
// An absolute date the model copied verbatim ("March 5, 2027") is normalised to the ERP's YYYY-MM-DD
// form; a relative or unparseable date ("next Friday", "下周五") is left as-is so a human confirms
// it instead of the app inventing a day.
export function normalizeDate(s: string): string {
  const t = s.trim();
  if (!t || validDate(t)) return t;
  const parsed = Date.parse(t);
  if (!Number.isNaN(parsed)) {
    // Format with LOCAL date components, not toISOString(), so a date like "March 8, 2027" does
    // not shift a day under a non-UTC timezone.
    const d = new Date(parsed);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (validDate(iso)) return iso;
  }
  return t;
}
/** Strips thousands separators, but only when the whole value is a validly grouped integer.
 *  A comma followed by one or two digits ("1,5") is a decimal in German, Russian or Ukrainian,
 *  so it is left alone and blocked for a human: silently reading 1,5 as 15 would multiply a
 *  real order line by ten, which is far worse than a review prompt. */
export function normalizeQuantity(s: string): string {
  const value = s.replace(/[\s\u00a0\u202f]+/g, ' ').trim();
  return /^\d{1,3}(?:[,\u00a0\u202f ]\d{3})+$/.test(value) ? value.replace(/\D/g, '') : value;
}
export function validate(d: Draft): Issue[] {
  const issues: Issue[] = [];
  for (const f of fields) if (!d[f].trim()) issues.push({code:'MISSING', field:f, message:`Missing ${f}`});
  if (!validDate(d.date)) issues.push({code:'INVALID_DATE', field:'date', message:'Use a valid YYYY-MM-DD date'});
  if (!d.lines.length) issues.push({code:'MISSING_LINES',field:'lines',message:'At least one line required'});
  d.lines.forEach((l,i) => {
    if (!l.item) issues.push({code:'UNRESOLVED_ITEM',field:`lines.${i}.item`,message:'No exact ERP item matched — map it to an existing item or remove this line'});
    if (!/^[1-9]\d{0,8}$/.test(l.quantity)) issues.push({code:'INVALID_QUANTITY',field:`lines.${i}.quantity`,message:'Only positive whole quantities (up to 999999999) supported'});
    if (!l.unit) issues.push({code:'MISSING_UNIT',field:`lines.${i}.unit`,message:'Unit required'});
  });
  return issues;
}

// The assistant may materialise a proposal into ERP without waiting for a human only while
// this returns an empty string. Every other outcome stays behind the review interrupt, which
// is what keeps unparsed, conflicting or ambiguous mail out of the ERP.
export function orderConformance(extracted: Extraction, issues: Issue[]): string {
  if (extracted.intent?.kind !== 'purchase') return 'the intent is not an explicit purchase';
  if (issues.length) return `deterministic validation failed: ${[...new Set(issues.map(i => i.code))].join(', ')}`;
  return '';
}

export function inquiryConformance(extracted: Extraction, replyDraft: string): string {
  const kind = extracted.intent?.kind;
  if (kind !== 'inquiry' && kind !== 'conditional') return 'the intent is not a determinate inquiry';
  // A reply promises to check, it does not ship anything, so an unresolved address role (shipping
  // versus billing) is not a reason to stop answering. Every other warning still blocks, because
  // the reply may repeat it back to the customer.
  const blocking = (extracted.warnings ?? []).filter(w => w.code !== 'UNRESOLVED_ADDRESS_ROLE');
  if (blocking.length) return `extraction warnings: ${[...new Set(blocking.map(w => w.code))].join(', ')}`;
  if (!replyDraft.trim()) return 'the reply draft is empty';
  return '';
}
