import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { type Extraction, type Source } from './domain.js';

const line=z.object({description:z.string().min(1),quantity:z.string().min(1)}).strict();
export const normalizedExtraction=z.object({
  status:z.literal('ok'),language:z.string(),intent:z.string(),customer:z.array(z.string()),sender:z.array(z.string()),
  date:z.array(z.string()),lines:z.array(line),evidenceValid:z.boolean()
}).strict();
const historical=z.union([normalizedExtraction,z.object({status:z.literal('error'),error:z.string().min(1)}).strict()]);
const expected=normalizedExtraction.omit({status:true,evidenceValid:true});
const evaluationCase=z.object({id:z.string().min(1),inputs:z.object({sources:z.array(z.object({source:z.enum(['email','pdf']),page:z.number().int().nonnegative(),text:z.string().min(1)}).strict()).min(1)}).strict(),expected,historical}).strict();
export const evaluationFixture=z.object({humanVerified:z.literal(true),verifiedBy:z.string().min(1),verificationDate:z.string().date(),cases:z.array(evaluationCase).min(1)}).strict();
export type EvaluationFixture=z.infer<typeof evaluationFixture>;
export type ExpectedExtraction=z.infer<typeof expected>;
export type NormalizedExtraction=z.infer<typeof normalizedExtraction>;

export async function readEvaluationFixture(path:string) {
  return evaluationFixture.parse(JSON.parse(await readFile(path,'utf8')));
}

export function normalizeExtraction(value:Extraction):NormalizedExtraction {
  return {status:'ok',language:value.reply?.language??'',intent:value.intent?.kind??'',
    customer:value.facts.customer.map(f=>f.value),sender:value.facts.sender.map(f=>f.value),date:value.facts.date.map(f=>f.value),
    lines:value.lines.map(l=>({description:l.description.value,quantity:l.quantity.value})),evidenceValid:true};
}

const norm=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en');
const sameStrings=(actual:unknown,expected:string[])=>Array.isArray(actual)&&actual.length===expected.length&&
  [...actual].map(String).map(norm).sort().every((value,index)=>value===[...expected].map(norm).sort()[index]);
const sameLines=(actual:unknown,expected:ExpectedExtraction['lines'])=>Array.isArray(actual)&&actual.length===expected.length&&
  actual.map(v=>`${norm(String(v?.description??''))}\t${norm(String(v?.quantity??''))}`).sort()
    .every((value,index)=>value===expected.map(v=>`${norm(v.description)}\t${norm(v.quantity)}`).sort()[index]);

export function extractionScores(output:unknown,reference:ExpectedExtraction) {
  const value=output&&typeof output==='object'?output as Record<string,unknown>:{};
  const scores={
    language_match:norm(String(value.language??''))===norm(reference.language)?1:0,
    intent_match:value.intent===reference.intent?1:0,
    customer_match:sameStrings(value.customer,reference.customer)?1:0,
    sender_match:sameStrings(value.sender,reference.sender)?1:0,
    date_match:sameStrings(value.date,reference.date)?1:0,
    lines_match:sameLines(value.lines,reference.lines)?1:0,
    evidence_grounded:value.evidenceValid===true?1:0
  } as const;
  return {...scores,regression_pass:Object.values(scores).every(score=>score===1)?1:0};
}

export function assertSourcesAreFictional(sources:Source[]) {
  if(!sources.length||sources.some(source=>!source.text.trim()))throw Error('EVALUATION_SOURCE_REQUIRED');
}
