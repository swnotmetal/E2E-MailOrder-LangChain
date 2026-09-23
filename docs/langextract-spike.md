# LangExtract Compatibility Spike

Date: 2026-09-23

## Decision

Do not add LangExtract or a Python runtime to the application.

The isolated spike proved that LangExtract 1.7.0 can call the project's fixed `gemini-2.5-flash-lite` model with one extraction pass, one worker, provider retries disabled, and Google SDK attempts set to one. Each attempted call was recorded in the existing local model ledger and wrapped in a LangSmith trace.

It did not satisfy the repository's evidence contract. The full `lx.extract` pipeline returned `match_exact` character intervals that did not reproduce the extraction when applied to the original source string. Offset drift appeared in English and Estonian, while the German result also contained damaged characters and fuzzy/lesser matches. The standalone LangExtract resolver aligned a small controlled string correctly, so the observed failure belongs to the complete annotation/chunking path rather than basic package import or model availability.

## Real integration evidence

All inputs were fictional. Three live Gemini calls completed without automatic retries:

| Language | Model output | Strict `source.slice(start,end) === extraction_text` result | LangSmith trace |
| --- | --- | --- | --- |
| English | 12 extractions | 0/12 | `01a0cf09-3f34-7000-8000-006177d03dfd` |
| German | 10 extractions | 1/10 | `01a0cf09-5210-7000-8000-00a5f0e50a66` |
| Estonian | 12 extractions | 0/12 | `01a0cf09-62f8-7000-8000-03dc7c338987` |

There was also one local harness failure before any model request. It was still recorded in the ledger and LangSmith as a failed attempt, then corrected because it was not an API, quota, or rate-limit error.

## What remains useful

LangExtract's extraction classes, ordered repeated-mention alignment, and visualization are useful design references. They are not sufficient evidence to replace the current TypeScript extractor in this repository without either accepting fuzzy offsets or adding another repair layer, which would defeat the purpose of adopting the package.

The application therefore keeps its current extractor boundary and focuses the next slice on workflow behavior: truthful failure routing and useful same-language inquiry replies generated only after read-only ERP inventory checks.

## Follow-up workflow verification

The English Tallinna Kliimatehnika inquiry was then run through the revised application with one live `gemini-2.5-flash-lite` understanding call. It reached `inquiry-review`, selected English from the request prose rather than the Estonian company identity, queried every uniquely matched item through the read-only ERP adapter, and produced a six-line draft. The result reported `FILTER-A20` at recorded stock 0, `THERM-S1` at recorded stock 40, and left four catalog-ambiguous or missing items unresolved. It made zero ERP writes. LangSmith trace: `01a0cf37-5157-7000-8000-02a751e0df35`.
