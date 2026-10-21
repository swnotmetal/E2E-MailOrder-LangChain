// Turns natively received mail into the record a human edits and decides on.
//
// This file is wiring only: load config, build the real ERP and model, then hand them to
// runInquirySync. The logic lives in src/inquiry-pipeline.ts, where it is tested without a site.
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
import { erpConfig, loadEnvFiles, modelConfig } from '../src/config.js';
import { FrappeERP, type ERP } from '../src/erp.js';
import { runInquirySync, type MailResult, type ProcessMail } from '../src/inquiry-pipeline.js';
import { log } from '../src/log.js';
import { geminiExtractor, geminiInquiryReply } from '../src/model.js';
import { workflow } from '../src/workflow.js';

loadEnvFiles();
const settings = erpConfig();
// Validated before the first write, so a missing key cannot fail halfway through filing.
modelConfig();

const erp = new FrappeERP(settings.base, `token ${settings.token}`, settings.company);
const dataDir = resolve(process.env.ORDER_DATA_DIR ?? 'data');
const extractor = geminiExtractor(dataDir);
const draftModel = geminiInquiryReply(dataDir);

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

const processMail: ProcessMail = async (sources, threadId): Promise<MailResult> => {
  const saver = SqliteSaver.fromConnString(':memory:');
  try {
    const graph = workflow(reading, saver, extractor, draftModel);
    const config = { configurable: { thread_id: threadId } };
    await graph.invoke({ sources }, config);
    const values = (await graph.getState(config)).values;
    return {
      lines: values.availability ?? [],
      reply: values.inquiry?.responseDraft ?? '',
      purchaseOrder: values.draft?.po ?? values.extracted?.facts?.po?.[0]?.value ?? '',
      customerText: values.extracted?.facts?.customer?.[0]?.value ?? '',
    };
  } finally {
    saver.db.close();
  }
};


// The pipeline itself lives in src/inquiry-pipeline.ts so it can be tested without a live site.
const summary = await runInquirySync({
  erp: {
    list: (doctype, fields, filters) => erp.list(doctype, fields, filters),
    request: (path, body, method) => erp.request(path, body, method),
    findCustomers: text => erp.findCustomers(text),
  },
  processMail,
  draftReply: async (mail, customer) => (await draftModel({
    intent: 'inquiry', customerText: mail.body, senderName: mail.senderName, customer,
    lines: [], condition: '', requestedDate: '', deliveryAddress: '', needs: [],
    replyLanguage: '', responseDraft: '',
  })).draft,
});

log('inquiry.sync.done', { ...summary });
process.stdout.write(
  `${summary.filed} Inquiry record(s), ${summary.screened} screened out, ${summary.quotations} quotation(s)\n`,
);
