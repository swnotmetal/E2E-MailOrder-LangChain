# Project model policy

## Project purpose

This is an open-source engineering portfolio and learning project published on GitHub. Its acceptance criterion is a clear, credible demonstration of engineering ability with LangChain, LangGraph, LangSmith, human review, tool boundaries, persistence, recovery, testing, and ERP integration patterns. It does not need business value, commercial ROI, production throughput, customer adoption, or proof that it saves labor. Do not distort the project merely to invent a business case. Keep product behavior coherent enough to demonstrate the engineering concepts honestly, and label mock, real, and unverified evidence precisely.

All project model tests and model-calling features must use only Gemini 2.5 Flash-Lite (`gemini-2.5-flash-lite`). Use the shared fixed-model Google API entry in `src/model.ts` and `GOOGLE_API_KEY`; do not add another model, provider, fallback, or model override. Deterministic/mock tests make no live model calls.

Use fictional data only. The user revoked the two-request / $0.05 local cap on 2026-09-22. Preserve the existing ledger and record every attempted request, including failures, without a local request or spending cap. Stop on quota, rate-limit or other API errors; do not automatically retry or switch providers. Free-tier availability and billing are controlled by the Google project, not this ledger. Models cannot write ERP. Inventory tools are read-only. Clearly distinguish mock tests, real integration evidence, and unverified claims.
