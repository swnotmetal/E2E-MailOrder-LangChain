import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { decodeMail } from './mime.js';
import { type Source, type Extraction, type Fact, factFields } from './domain.js';

// pdfjs splits a visual line into many text items. Joining them with a space is right for
// Latin text but corrupts CJK text, so no separator is added when either side of a
// boundary is a CJK character or punctuation mark.
const cjk=/[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
export function joinPdfItems(items:{str:string;hasEOL?:boolean}[]) {
  let text='';
  for(let index=0; index<items.length; index++) {
    const {str,hasEOL}=items[index];
    text+=str;
    if(index===items.length-1) break;
    if(hasEOL) { text+='\n'; continue; }
    const last=str.slice(-1), first=items[index+1].str.slice(0,1);
    if(!cjk.test(last) && !cjk.test(first)) text+=' ';
  }
  return text;
}

export async function readSources(email: string, pdf?: string): Promise<Source[]> {
  const mail = await readFile(email);
  if (mail.length > 1024*1024) throw Error('INPUT_TOO_LARGE');
  const raw = mail.toString('utf8');
  // A real MIME message is decoded into its text body; a plain UTF-8 fixture is read
  // verbatim so the existing template fixtures keep byte-exact evidence offsets.
  const isMime = /Content-Transfer-Encoding:\s*(base64|quoted-printable)|Content-Type:\s*multipart/i.test(raw);
  const decoded = isMime ? await decodeMail(mail) : undefined;
  const text = decoded ? decoded.text : raw;
  if (!text.trim()) throw Error('NO_MAIL_TEXT');
  const sources: Source[] = [{source:'email',page:0,text}];
  // The subject is its own source, not a prefix on the body. Business references — a customer PO,
  // an order or ticket number — very often exist only there, and merging it into the body would
  // forge offsets the original message never had. It stays separately citable and still verified.
  if (decoded?.subject.trim()) sources.push({source:'subject',page:0,text:decoded.subject.trim()});
  // The sender address is metadata the ERP needs to record the mail against, so it is its own
  // source rather than something the model has to guess out of a signature.
  if (decoded?.from.trim()) sources.push({source:'sender',page:0,text:decoded.from.trim()});
  const attachments = decoded ? decoded.pdfs.map(attachment=>attachment.content) : [];
  if (pdf) attachments.push(await readFile(pdf));
  let page = 0;
  for (const bytes of attachments) {
    if (bytes.length > 10*1024*1024) throw Error('INPUT_TOO_LARGE');
    page = await appendPdfPages(sources, bytes, page);
  }
  if (attachments.length && !sources.slice(1).some(s=>s.text.trim())) throw Error('NO_PDF_TEXT: OCR is not supported');
  return sources;
}

// Page numbers run across every attachment so a (source,page) pair stays unique evidence.
async function appendPdfPages(sources: Source[], bytes: Buffer, startPage: number) {
  const loading = getDocument({data:new Uint8Array(bytes), useSystemFonts:true});
  const doc = await loading.promise;
  try {
    if (doc.numPages > 20) throw Error('TOO_MANY_PAGES');
    let page = startPage;
    for(let index=1; index<=doc.numPages; index++) {
      const content = await (await doc.getPage(index)).getTextContent();
      sources.push({source:'pdf',page:++page,text:joinPdfItems(content.items.flatMap(item=>'str' in item ? [{str:item.str,hasEOL:item.hasEOL}] : []))});
    }
    return page;
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

