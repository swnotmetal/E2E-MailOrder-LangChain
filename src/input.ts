import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { type Source, type Extraction, type Fact, factFields } from './domain.js';

export async function readSources(email: string, pdf: string): Promise<Source[]> {
  const mail = await readFile(email);
  const bytes = await readFile(pdf);
  if (mail.length > 1024*1024 || bytes.length > 10*1024*1024) throw Error('INPUT_TOO_LARGE');
  const text = mail.toString('utf8');
  if (/Content-Transfer-Encoding:\s*(base64|quoted-printable)|Content-Type:\s*multipart/i.test(text)) throw Error('UNSUPPORTED_MIME: supply a plain UTF-8 email');
  const loading = getDocument({data:new Uint8Array(bytes), useSystemFonts:true});
  const doc = await loading.promise;
  try {
    if (doc.numPages > 20) throw Error('TOO_MANY_PAGES');
    const sources: Source[] = [{source:'email',page:0,text}];
    for(let page=1; page<=doc.numPages; page++) {
      const content = await (await doc.getPage(page)).getTextContent();
      let text = '';
      for(const item of content.items) if ('str' in item) text += item.str + (item.hasEOL ? '\n' : ' ');
      sources.push({source:'pdf',page,text});
    }
    if (!sources.slice(1).some(s=>s.text.trim())) throw Error('NO_PDF_TEXT: OCR is not supported');
    return sources;
  } finally { await loading.destroy(); }
}

// Deliberately bounded template adapter; unknown prose is not interpreted as a confirmed order.
export async function templateExtractor(sources: Source[]): Promise<Extraction> {
  const result: Extraction = {facts:{customer:[],sender:[],location:[],po:[],date:[],address:[]},lines:[]};
  const labels = {customer:'Customer',sender:'Sender',location:'Location',po:'PO',date:'Delivery',address:'Address'};
  for(const s of sources) {
    function fact(value: string, start: number): Fact {
      return {value:value.trim(), evidence:{source:s.source,page:s.page,start,end:start+value.length,quote:value}};
    }
    for(const f of factFields) {
      const regex = new RegExp(`^${labels[f]}:[ \\t]*(.+)$`,'gm');
      for(const m of s.text.matchAll(regex)) result.facts[f].push(fact(m[1],m.index!+m[0].length-m[1].length));
    }
    for(const m of s.text.matchAll(/^Item:[ \t]*([^|\r\n]+)\|([^|\r\n]+)\|([^|\r\n]+)/gm)) {
      let cursor = m.index! + m[0].length - m[1].length - m[2].length - m[3].length - 2;
      const description = fact(m[1],cursor); cursor += m[1].length+1;
      const quantity = fact(m[2],cursor); cursor += m[2].length+1;
      result.lines.push({description,quantity,unit:fact(m[3],cursor)});
    }
  }
  verifyEvidence(result,sources);
  return result;
}
export type Extractor = (sources:Source[])=>Promise<Extraction>;
export function verifyEvidence(e: Extraction, sources:Source[]) {
  const facts = [...Object.values(e.facts).flat(), ...e.lines.flatMap(l=>Object.values(l))];
  for(const f of facts) {
    const s = sources.find(s=>s.source===f.evidence.source && s.page===f.evidence.page);
    if (!s || s.text.slice(f.evidence.start,f.evidence.end)!==f.evidence.quote || f.value!==f.evidence.quote.trim()) throw Error('INVALID_EVIDENCE');
  }
}

