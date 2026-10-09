## KEV Finnish exploratory test

Status: paused 2026-10-09. No KEV fine-tuning or application integration; the supported application model remains Gemini 2.5 Flash-Lite.

- One fictional Helsinki email smoke: KEV-0.8B v1.0 chose `unclear` (confidence `0.0842`); reference `inquiry`, historical Gemini `conditional`.
- FinnSentiment-1.1 (CC BY 4.0), sentiment polarity only: balanced 300-row sample from split 20 scored `0.5867` accuracy / `0.5831` macro-F1. This does not measure email intent; training overlap is unknown.
- 24 fictional Finnish intent examples were manually reviewed and accepted without edits by the repository owner (self-assessed B2-C1). A zero-shot run performed before review matched 15/24 labels (`0.625`, macro-F1 `0.5875`); purchase recall was 1/6. Retrospective single-reviewer agreement is not an independent accuracy estimate.
- ScandiSent remains unused: the downloaded package has no accompanying license/readme. No public task-matched Finnish business email corpus was established in this experiment.

Generated KEV outputs, checkpoint, and model cache were removed after recording this summary. Raw downloaded corpora (`finsen-v1-1-src/`, `ScandiSent/`) remain local and Git-ignored. This note records a bounded engineering exploration, not multilingual readiness or a production claim.