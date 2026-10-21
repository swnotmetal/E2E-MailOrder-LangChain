# Architecture Decisions

Each entry is one decision, why we made it, what we rejected, and when we would revisit it. Written for a future maintainer reading this as an engineering portfolio.

## 1. The model proposes, deterministic code decides

**Decision.** The model only extracts facts and drafts text. Every gate — item match, quantity normalization, address resolution, conformance — is a deterministic TypeScript check in `src/domain.ts`. The model's output is verified against the evidence sources before it can influence the flow.

**Why.** A portfolio must demonstrate correctness that is testable without a model in the loop. Deterministic gates are fully unit-tested (`test/domain.test.ts`, `test/mime.test.ts`), so we can prove the system degrades safely when the model hallucinates.

**Rejected.** Letting the model emit `approve`/`reject` and writing it straight to ERP. That makes correctness unverifiable and couples a write side-effect to a stochastic output.

**Revisit when.** If a specific gate becomes too rigid to express as rules, we would add a *scored* classifier only after it is evaluated against a labeled gold set in LangSmith — not as a free pass.

## 2. Human review lives in ERPNext, not in our app

**Decision.** There is no approval UI in this repo. A human approves or rejects inside ERPNext by submitting the draft Sales Order, or by running the `Qualify`/`Reject` transitions on the `Inquiry` workflow. LangGraph's `interrupt` pauses on the draft write and resumes from ERP `docstatus`/`workflow_state` via `src/review-sync.ts`.

**Why.** The people who review orders are ERP users. Duplicating their review surface in a web lab creates two sources of truth and two login flows. ERPNext already gives us draft-vs-submitted permission split and a workflow engine for free.

**Rejected.** A web "observation console" with approve/reject buttons. It re-implements what ERPNext already does and splits the audit trail.

**Revisit when.** If a reviewer needs context the ERP form cannot show (e.g. the raw email thread), we would link that read-only context out from the ERP document, never re-add an approval button.

## 3. The model has zero write credentials

**Decision.** The integration user (`sales@example.invalid`) holds only `Sales User` + `Inbox User`. `src/erp.ts` stubs out every write when reading inbound mail, and the write path only ever creates a *draft* Sales Order and files a Communication. No `DELETE`, no `submit`, no `cancel` from our service.

**Why.** "Models cannot write ERP" (AGENTS.md) is a hard boundary. Keeping writes to draft-only means a bad extraction can only produce a draft a human must inspect.

**Rejected.** Granting `System Manager` to the integration account for convenience. It would let a hallucinated payload submit orders autonomously.

**Revisit when.** Only if a customer contract explicitly requires unattended submission — and then via a separate, audited, non-model service.

## 4. SQLite checkpoints + idempotent keys, not a queue

**Decision.** Graph state persists in a SQLite checkpoint store. Every resume path keys on a stable integration key (the mail digest) so re-running is idempotent. We deliberately do **not** introduce a message queue.

**Why.** A queue adds an operator (and a resume story) for a workload that is low-volume B2B mail. SQLite gives durable `interrupt`/resume and easy recovery with zero infrastructure.

**Rejected.** Redis/Postgres checkpointing and a real queue (RabbitMQ/Kafka). Too much machinery for the demonstrated scale, and it would bury the LangGraph resume mechanics we want to show.

**Revisit when.** If throughput or multi-instance coordination becomes real, we would move the checkpoint store to Postgres first; a queue only after that.

## 5. Native ERPNext IMAP intake over webhooks

**Decision.** Inbound mail enters via GreenMail → ERPNext Email Account → `Communication` + `Lead`, deduplicated by `Message-ID`. Our pipeline (`scripts/inquiry-sync.ts`) reads the resulting `Lead`s.

**Why.** This exercises a real integration pattern (ERP's own mail ingestion + dedup) rather than us hand-rolling an SMTP listener, and it is what a real deployment would use.

**Rejected.** A self-hosted webhook/mail server and the ERPNext "Append To → custom DocType" shortcut. The latter is a hardcoded whitelist (ToDo, Opportunity, Event, Communication, Issue, Purchase Invoice, Lead) and cannot target our custom `Inquiry` DocType, so `Append To` = `Lead` + a read pass is the only native path.

**Revisit when.** If ERPNext opens `Append To` to custom DocTypes, we would simplify to a single native hop.

## 6. Deterministic keyword pre-screen, not a classifier model

**Decision.** Non-procurement mail is screened out by `src/triage.ts` — a deterministic keyword check that blocks only when it sees ≥2 solicitation markers, 0 procurement signals, and no quantity. It costs no model call and cannot be gamed by a single phrase.

**Why.** Model policy allows only `gemini-2.5-flash-lite` and forbids adding a second model/provider. A third-party spam/guardrail classifier would violate that. A deterministic pre-screen is testable, cheap, and transparent.

**Rejected.** A third-party classifier model or a second "screening" model. Disallowed by the single-model policy, and overkill for a demo.

**Revisit when.** If false-positive/negative rates on real mail demand it, we would evaluate a *rule + scoring* approach against a gold set before any model change.

## 7. Subject and sender are first-class evidence sources

**Decision.** `src/domain.ts`'s `Source` union includes `subject` and `sender` alongside `email` and `pdf`, so extracted facts are grounded against them like any other source.

**Why.** The subject line and From header carry real signal (PO number, contact) and deserve the same `verifyEvidence` grounding as the body and attachments. This also made the `MODEL_VALUE_NOT_IN_QUOTE` failure class (values not traceable to any source) surface and degrade gracefully instead of crashing.

**Rejected.** Treating the whole raw email as one opaque text blob. That loses provenance per fact and weakens the evidence-checking story.

**Revisit when.** Only if a new source type (e.g. a scanned attachment) needs the same treatment — the union already makes that a one-line extension.

## 8. Single model, no fallback, no auto-retry, ledger everything

**Decision.** Every model call goes through `src/model.ts` against `gemini-2.5-flash-lite`. On quota/rate-limit/API errors we stop, record the failed attempt, and do not retry or switch providers.

**Why.** AGENTS.md mandates exactly one model and forbids silent provider switching. Recording every attempt (including failures) keeps the spend/attempt ledger honest, which matters for a portfolio that claims transparency.

**Rejected.** A fallback model list and exponential-retry wrappers. They would hide the failure modes this project exists to demonstrate.

**Revisit when.** Never under the current policy; any change must come from an AGENTS.md update, not from code.
