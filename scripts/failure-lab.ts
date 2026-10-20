// Failure Lab: a runnable demonstration of how this workflow behaves when things go wrong.
// It reuses the in-process mock ERP, so it needs no Docker, no real ERPNext and no model calls.
// Run: npm run failure-lab
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockERP } from '../src/mock-erp.js';
import { FrappeERP } from '../src/erp.js';
import { workflow } from '../src/workflow.js';
import { readSources } from '../src/input.js';

type Mock = Awaited<ReturnType<typeof mockERP>>;
type Ctx = {
  mock: Mock;
  dir: string;
  saver: SqliteSaver;
  erp: FrappeERP;
  graph: ReturnType<typeof workflow>;
  close: () => Promise<void>;
};

async function harness(): Promise<Ctx> {
  const mock = await mockERP();
  const dir = await mkdtemp(join(tmpdir(), 'failure-lab-'));
  const saver = SqliteSaver.fromConnString(join(dir, 'checkpoints.sqlite'));
  const erp = new FrappeERP(mock.url, 'token test:test', 'Nordic Parts Demo', 1000);
  const graph = workflow(erp, saver);
  return {
    mock, dir, saver, erp, graph,
    close: async () => {
      try { saver.db.close(); } catch { /* already closed by a scenario */ }
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const cfg = (id = 'lab') => ({ configurable: { thread_id: id } });
const clean = () => readSources('fixtures/01-clean.eml', 'fixtures/01-clean.pdf');
const ambiguous = () => readSources('fixtures/02-ambiguous.eml', 'fixtures/02-ambiguous.pdf');

type Scenario = { name: string; proves: string; run: (x: Ctx) => Promise<string> };

const scenarios: Scenario[] = [
  {
    name: 'duplicate with changed content',
    proves: 'a re-delivered PO with different content is refused, never silently overwritten',
    run: async (x) => {
      await x.graph.invoke({ sources: await clean() }, cfg());
      const s = await x.graph.getState(cfg());
      await x.erp.createDraft(s.values.draft);
      const changed = structuredClone(s.values.draft);
      changed.lines[0].quantity = '7';
      let refused = '';
      try { await x.erp.createDraft(changed); } catch (e) { refused = (e as Error).message; }
      if (!refused.startsWith('DUPLICATE')) throw new Error(`expected a DUPLICATE refusal, got ${refused || 'a second write'}`);
      if (x.mock.posts !== 1) throw new Error(`expected 1 ERP write, got ${x.mock.posts}`);
      return `second write refused: ${refused}`;
    },
  },
  {
    name: 'ERP write times out after commit',
    proves: 'an uncertain write is reconciled by its integration key, not blindly written twice',
    run: async (x) => {
      await x.graph.invoke({ sources: await clean() }, cfg());
      const s = await x.graph.getState(cfg());
      x.mock.timeout();
      const [a, b] = await Promise.all([x.erp.createDraft(s.values.draft), x.erp.createDraft(s.values.draft)]);
      if (a.name !== b.name) throw new Error(`concurrent writes produced different orders: ${a.name} vs ${b.name}`);
      if (x.mock.posts !== 1) throw new Error(`expected 1 ERP write, got ${x.mock.posts}`);
      return `two concurrent calls -> same order ${a.name}, ${x.mock.posts} write`;
    },
  },
  {
    name: 'ERP unavailable',
    proves: 'a failed read leaves a retryable checkpoint instead of losing the message',
    run: async (x) => {
      x.mock.failReads(true);
      let failed = '';
      try { await x.graph.invoke({ sources: await clean() }, cfg()); } catch (e) { failed = (e as Error).message; }
      if (!/ERP_HTTP_503/.test(failed)) throw new Error(`expected ERP_HTTP_503, got ${failed || 'no error'}`);
      x.mock.failReads(false);
      await x.graph.invoke(null, cfg());
      const s = await x.graph.getState(cfg());
      if (s.values.status !== 'needs-human') throw new Error(`expected status needs-human after retry, got ${s.values.status}`);
      return `first attempt failed (${failed}); retry reached status ${s.values.status}`;
    },
  },
  {
    name: 'ambiguous item stays blocked',
    proves: 'an unresolved item never reaches the ERP',
    run: async (x) => {
      await x.graph.invoke({ sources: await ambiguous() }, cfg());
      const s = await x.graph.getState(cfg());
      if (s.values.draft.lines[0].item !== '') throw new Error('ambiguous fixture unexpectedly matched an item');
      if (s.values.status !== 'needs-human') throw new Error(`expected status needs-human, got ${s.values.status}`);
      if (x.mock.posts !== 0) throw new Error(`expected 0 ERP writes, got ${x.mock.posts}`);
      return `unresolved item stayed out of the ERP; status ${s.values.status}, ${x.mock.posts} writes`;
    },
  },
];

async function main() {
  console.log('Failure Lab — how this workflow behaves when things go wrong');
  console.log('Mock ERP, no model calls, no Docker. Each scenario runs in isolation.\n');
  let failures = 0;
  for (const sc of scenarios) {
    const x = await harness();
    let result = '';
    let ok = true;
    try { result = await sc.run(x); }
    catch (e) { ok = false; result = (e as Error).message; }
    finally { await x.close(); }
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${sc.name}`);
    console.log(`      proves: ${sc.proves}`);
    console.log(`      result: ${result}\n`);
  }
  console.log(`${scenarios.length - failures}/${scenarios.length} failure scenarios behaved as designed.`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
