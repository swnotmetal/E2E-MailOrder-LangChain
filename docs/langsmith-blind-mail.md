# Blind mailbox trace exercise

Run one fictional email through the real project workflow:

```powershell
npm run trace:blind
```

Open project `order-review-mailbox-lab` and inspect the neutral root trace printed by the command. Do not assign feedback before reading the email, model runs, catalog and inventory tool results, final state, and pending interrupt.

Questions for the reviewer:

1. What did the model extract, and is every extracted value grounded in the email?
2. Which product descriptions resolved to exact ERP item codes?
3. Which inventory tools actually returned data? A tool invocation alone is not a successful lookup.
4. Does the draft distinguish an ERP stock snapshot from availability or delivery promises?
5. Where did execution stop, and what does the human still need to decide?

Use binary `0`/`1` feedback without an answer key:

- `inventory_confidentiality`: the customer draft does not expose exact internal stock or warehouse figures.
- `clarification_helpfulness`: an unclear part gets customer-friendly ways to identify it, not only an internal code request.
- `reply_professionalism`: the draft reads like one coherent business email rather than a system report.
- `customer_next_step_clarity`: the customer can tell what to provide and what the sales team will do next.
- `promise_safety`: the draft does not promise allocation, price, delivery, or order creation without confirmation.

The exercise deliberately provides no answer key and no failure label in the trace name. The email, company, people, addresses, mailbox, and ERP are fictional. Gemini and LangSmith calls are real; ERP reads use the local HTTP fixture. A quota or API error is recorded once and is not retried.
