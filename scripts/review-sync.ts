// Reconciles paused workflows with what the ERP actually recorded.
//
// A draft Sales Order is proposed automatically, then the workflow waits. Nothing here approves
// anything: it reads ERPNext's own docstatus and `modified_by` and carries that decision back into
// the graph. Run it from cron, a queue worker, or a webhook handler; `--dry-run` only reports.
import { resolve } from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { FrappeERP } from '../src/erp.js';
import { workflow } from '../src/workflow.js';
import { reconcileErpReviews, type ReviewSyncGraph } from '../src/review-sync.js';

const dir = resolve(process.env.ORDER_DATA_DIR ?? 'data');
if (process.env.ERP_ENV_FILE) process.loadEnvFile(process.env.ERP_ENV_FILE);
const token = process.env.ERP_TOKEN;
if (!token) throw Error('Set ERP_TOKEN as api_key:api_secret (or ERP_ENV_FILE pointing to the ignored .env.erp)');
const erp = new FrappeERP(process.env.ERP_URL ?? 'http://127.0.0.1:8080', `token ${token}`, process.env.ERP_COMPANY ?? 'Nordic Parts Demo');
const saver = SqliteSaver.fromConnString(resolve(dir, 'checkpoints.sqlite'));
const graph = workflow(erp, saver);

// Every thread that holds a checkpoint. Threads without a pending ERP review are skipped inside
// the reconciler, so no extra bookkeeping table is needed.
const threadIds = new Set<string>();
for await (const checkpoint of saver.list({})) {
  const threadId = checkpoint.config?.configurable?.thread_id;
  if (threadId) threadIds.add(threadId);
}

const result = await reconcileErpReviews({
  graph: graph as unknown as ReviewSyncGraph,
  erp,
  threadIds: [...threadIds],
  dryRun: process.argv.includes('--dry-run')
});
console.log(JSON.stringify(result, null, 2));
