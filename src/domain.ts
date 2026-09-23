import { z } from 'zod';
import { createHash } from 'node:crypto';

export const fields = ['customer', 'po', 'date', 'address'] as const;
export type Field = typeof fields[number];
export const factFields = [...fields, 'sender', 'location'] as const;
export type FactField = typeof factFields[number];
export type Evidence = { source: 'email' | 'pdf'; page: number; start: number; end: number; quote: string };
export type Fact = { value: string; evidence: Evidence };
export type Source = { source: 'email' | 'pdf'; page: number; text: string };
export type Extraction = { facts: Record<FactField, Fact[]>; lines: { description: Fact; quantity: Fact; unit: Fact }[];
  intent?:{kind:'purchase'|'inquiry'|'conditional'|'unclear';evidence:Fact}; reply?:{language:string;draft:string}; traceId?:string };
export type Customer = { name: string; customer_name: string };
export type Item = { name: string; item_name: string; stock_uom: string; disabled?: number };
export type Address = { name: string; text: string };
export type Issue = { code: string; field: string; message: string };
export type InquiryCase = {
  intent:'inquiry'|'conditional'|'unclear'; customerText:string; senderName:string; customer:string;
  itemText:string; itemCode:string; quantity:string; condition:string;
  inventory:{stockTracked:boolean;totalActualQty:number|null}|null;
  needs:string[]; replyLanguage:string; responseDraft:string;
};
export const DraftSchema = z.object({
  customer: z.string(), po: z.string(), date: z.string(), address: z.string(),
  lines: z.array(z.object({ description: z.string(), item: z.string(), quantity: z.string(), unit: z.string() }).strict())
}).strict();
export type Draft = z.infer<typeof DraftSchema>;
export const DecisionSchema = z.object({
  action: z.enum(['approve', 'reject', 'request-info']), revision: z.string(),
  actor: z.string().trim().min(1), reason: z.string(), draft: DraftSchema, confirmPurchase:z.boolean().optional()
}).strict();
export type Decision = z.infer<typeof DecisionSchema>;
export const InquiryDecisionSchema=z.object({
  action:z.enum(['approve-reply','request-info','close']),revision:z.string(),actor:z.string().trim().min(1),
  reason:z.string(),responseDraft:z.string().trim().min(1)
}).strict();
export type InquiryDecision=z.infer<typeof InquiryDecisionSchema>;
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const normalize = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
export const orderKey = (d: Draft) => digest([d.customer, normalize(d.po)]);
export function validDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s;
}
export function validate(d: Draft): Issue[] {
  const issues: Issue[] = [];
  for (const f of fields) if (!d[f].trim()) issues.push({code:'MISSING', field:f, message:`Missing ${f}`});
  if (!validDate(d.date)) issues.push({code:'INVALID_DATE', field:'date', message:'Use a valid YYYY-MM-DD date'});
  if (!d.lines.length) issues.push({code:'MISSING_LINES',field:'lines',message:'At least one line required'});
  d.lines.forEach((l,i) => {
    if (!l.item) issues.push({code:'UNRESOLVED_ITEM',field:`lines.${i}.item`,message:'Select an exact ERP item'});
    if (!/^[1-9]\d{0,8}$/.test(l.quantity)) issues.push({code:'INVALID_QUANTITY',field:`lines.${i}.quantity`,message:'Only positive whole quantities (up to 999999999) supported'});
    if (!l.unit) issues.push({code:'MISSING_UNIT',field:`lines.${i}.unit`,message:'Unit required'});
  });
  return issues;
}
