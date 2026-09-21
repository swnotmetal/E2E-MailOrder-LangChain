# Project model policy

All project model tests and model-calling features must use only Gemini 2.5 Flash-Lite (`gemini-2.5-flash-lite`). Use the shared fixed-model Google API entry in `src/model.ts` and `GOOGLE_API_KEY`; do not add another model, provider, fallback, or model override. Deterministic/mock tests make no live model calls.

Use fictional data only. Preserve the existing maximum of two requests and $0.05 total budget ledger, including failed requests; never reset it to bypass the limit. Models cannot write ERP. Inventory tools are read-only. Clearly distinguish mock tests, real integration evidence, and unverified claims.
