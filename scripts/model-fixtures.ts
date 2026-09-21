import { writeFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
const examples=[
  {id:'natural-clear', mail:'Acme Workshop is placing PO DEMO-NL-01. Please send 5 units of FILTER-A10, unit Nos. We need delivery on 2027-02-20 to 10 Test Road, Helsinki, 00100, Finland.',
   pdf:'Purchase order DEMO-NL-01 for Acme Workshop. Deliver FILTER-A10, quantity 5 Nos, on 2027-02-20. Ship to 10 Test Road, Helsinki, 00100, Finland.'},
  {id:'natural-conflict', mail:'Acme Workshop sends PO DEMO-NL-02. Please ship 5 Nos of the Filter series for 2027-02-20. Destination: 10 Test Road, Helsinki, 00100, Finland.',
   pdf:'Our purchase order DEMO-NL-02 is for Acme Workshop. The requested Filter series quantity is 8 Nos. Deliver by 2027-02-20 to 10 Test Road, Helsinki, 00100, Finland.'}
];
for(const e of examples){
  await writeFile(`fixtures/${e.id}.eml`,`From: buyer@example.invalid\nTo: sales@example.invalid\nSubject: purchase request\nContent-Type: text/plain; charset=utf-8\n\n${e.mail}\n`);
  const doc=await PDFDocument.create();doc.setCreationDate(new Date('2026-01-01'));doc.setModificationDate(new Date('2026-01-01'));
  const font=await doc.embedFont(StandardFonts.Helvetica);const page=doc.addPage([595,842]);
  const words=e.pdf.split(' ');let line='',y=780;
  for(const word of words){if((line+' '+word).length>75){page.drawText(line,{x:45,y,size:12,font});y-=20;line=word;}else line+=(line?' ':'')+word;}
  page.drawText(line,{x:45,y,size:12,font});await writeFile(`fixtures/${e.id}.pdf`,await doc.save());
}
console.log('Two fictional natural-language smoke inputs ready; no model called.');
