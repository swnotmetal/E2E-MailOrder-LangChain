import { Command } from '@langchain/langgraph';
import { orderKey, type Draft } from './domain.js';
import { type ERP } from './erp.js';

// The approval decision lives in ERPNext, not in this application. A sales person opens the draft
// Sales Order in the ERP, edits it if needed and submits it (or cancels it). This reconciler reads
// that state back and resumes the paused workflow with what the ERP says happened.
//
// It is deliberately not an approval endpoint: it cannot approve anything. The only two things it
// can report are "the ERP shows this document submitted" and "the ERP shows it cancelled or gone",
// and both carry ERPNext's own `modified_by` as the actor.

type PendingReview = { kind?: string; revision?: string; erpDocument?: string };

// Structural subset of the compiled graph, so a caller can pass the real graph without generics.
export type ReviewSyncGraph = {
  getState: (config: { configurable: { thread_id: string } }) => Promise<{
    values: { draft?: Draft };
    tasks: { interrupts: { value: unknown }[] }[];
  }>;
  stream: (input: unknown, config: { configurable: { thread_id: string } }) => Promise<AsyncIterable<unknown>>;
};

export type ReviewSyncResult = {
  checked: number;
  pending: number;
  resumed: { threadId: string; action: 'approve' | 'reject'; erpDocument: string; actor: string; reason: string }[];
};

export async function reconcileErpReviews(options: {
  graph: ReviewSyncGraph;
  erp: ERP;
  threadIds: string[];
  dryRun?: boolean;
}): Promise<ReviewSyncResult> {
  const result: ReviewSyncResult = { checked: 0, pending: 0, resumed: [] };
  for (const threadId of options.threadIds) {
    const config = { configurable: { thread_id: threadId } };
    let state;
    try {
      state = await options.graph.getState(config);
    } catch {
      continue; // A thread with no checkpoint is not an error, it just has nothing to reconcile.
    }
    result.checked += 1;
    const pending = state.tasks
      .flatMap((task) => task.interrupts.map((item) => item.value))
      .find((value): value is PendingReview => !!value && (value as PendingReview).kind === 'order-review');
    if (!pending?.erpDocument || !pending.revision) continue;
    result.pending += 1;

    const draft = state.values.draft;
    if (!draft) continue;
    // Re-read the document by its integration key rather than trusting the stored name, so a draft
    // renamed or recreated in the ERP is still recognised as this proposal.
    const erpState = await options.erp.reviewState(orderKey(draft));

    let action: 'approve' | 'reject';
    let actor: string;
    let reason: string;
    if (!erpState) {
      // The draft was deleted outright. A submitted document cannot be deleted, so its absence
      // means a human discarded the proposal.
      action = 'reject';
      actor = 'unknown';
      reason = 'draft no longer exists in the ERP';
    } else if (erpState.docstatus === 1) {
      action = 'approve';
      actor = erpState.actor;
      reason = `submitted in ERPNext at ${erpState.modified}`;
    } else if (erpState.docstatus === 2) {
      action = 'reject';
      actor = erpState.actor;
      reason = `cancelled in ERPNext at ${erpState.modified}`;
    } else {
      continue; // Still an open draft: a human has not decided yet.
    }

    // The digest guards against resuming with content that no longer matches what the ERP holds.
    if (erpState && erpState.digest && erpState.digest !== pending.revision) {
      action = 'reject';
      reason = 'the ERP document no longer matches the proposal this workflow made';
    }

    const decision = { action, revision: pending.revision, actor, reason, source: 'erpnext' as const, erpDocument: pending.erpDocument };
    result.resumed.push({ threadId, action, erpDocument: pending.erpDocument, actor, reason });
    if (options.dryRun) continue;
    for await (const _event of await options.graph.stream(new Command({ resume: decision }), config)) {
      // Events are consumed so the graph runs to its next interrupt or end.
    }
  }
  return result;
}
