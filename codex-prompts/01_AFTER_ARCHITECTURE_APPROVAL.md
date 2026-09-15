# Codex Task — Proceed After Architecture Approval

Use this only after the FlowPay architecture has been reviewed and explicitly accepted.

Read:

- `AGENTS.md`
- `docs/HACKATHON_PROPOSAL.md`
- `docs/PRODUCT_REQUIREMENTS.md`
- `docs/DEMO_SCENARIO.md`
- `docs/CURRENT_QESUITE_ARCHITECTURE.md`
- `docs/FLOWPAY_RECOMMENDED_ARCHITECTURE.md`

Confirm the architecture document status is **Accepted**.

Then:

1. derive the detailed domain model;
2. derive the persistence model;
3. define APIs/services;
4. define event/message contracts if applicable;
5. define provider abstraction;
6. define accounting integration;
7. define failure/retry/idempotency behavior;
8. define test strategy;
9. create an implementation roadmap;
10. begin only the first coherent foundational milestone.

Preserve the product concept:

**Business Event → Rule/Conditions → Approval → Settlement → Accounting → Reconciliation → Audit**

Do not hardcode workshop-specific concepts into the reusable FlowPay core.
