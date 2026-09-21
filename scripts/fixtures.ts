import { mkdir, writeFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
const cases=[
  {id:'01-clean'}, {id:'02-ambiguous',item:'Filter'}, {id:'03-quantity-conflict',qty:'8'},
  {id:'04-duplicate',po:'DEMO-001'}, {id:'05-timeout'}, {id:'06-missing-date',date:''},
  {id:'07-address-mismatch',address:'99 Unknown Road, Helsinki, 00100, Finland'},
  {id:'08-unknown-customer',customer:'Unknown Workshop'}, {id:'09-invalid-quantity',qty:'-2'}, {id:'10-resume'}
];
await mkdir('fixtures',{recursive:true});
for(const [index,c] of cases.entries()) {
  const po=c.po??`DEMO-${String(index+1).padStart(3,'0')}`;
  const text=(attachment:boolean)=>[
    `Customer: ${c.customer??'Acme Workshop'}`,`PO: ${po}`,`Delivery: ${c.date??'2027-02-20'}`,
    `Address: ${c.address??'10 Test Road, Helsinki, 00100, Finland'}`,
    `Item: ${c.item??'FILTER-A10'} | ${attachment?(c.qty??'5'):'5'} | Nos`
  ].join('\n');
  await writeFile(`fixtures/${c.id}.eml`,`From: buyer@example.invalid\nTo: sales@example.invalid\nSubject: ${po}\nContent-Type: text/plain; charset=utf-8\n\n${text(false)}\n`);
  const doc=await PDFDocument.create(); doc.setCreationDate(new Date('2026-01-01')); doc.setModificationDate(new Date('2026-01-01'));
  const page=doc.addPage([595,842]); const font=await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(`FICTIONAL PURCHASE ORDER\n\n${text(true)}`,{x:45,y:780,size:12,font,lineHeight:24});
  await writeFile(`fixtures/${c.id}.pdf`,await doc.save());
}
console.log('10 development email/PDF pairs generated; provisional expectations are in docs/design.md.');
