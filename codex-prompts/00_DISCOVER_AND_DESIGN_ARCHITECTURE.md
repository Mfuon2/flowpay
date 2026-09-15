# Codex Task — Discover QeSuite and Design FlowPay Architecture

We are starting **QeSuite FlowPay**.

Before doing any major implementation, read:

- `AGENTS.md`
- `START_HERE.md`
- `docs/HACKATHON_PROPOSAL.md`
- `docs/PRODUCT_REQUIREMENTS.md`
- `docs/DEMO_SCENARIO.md`
- `docs/OPEN_ARCHITECTURE_QUESTIONS.md`

Important:

**The product concept is agreed. The software architecture is not.**

Do not treat conceptual diagrams as final architecture.

## Phase 1 — Inspect the existing QeSuite repository

Determine:

1. overall repository structure;
2. frontend framework and structure;
3. backend/API structure;
4. package/workspace structure;
5. database technology;
6. ORM/query layer if any;
7. migration approach;
8. authentication;
9. authorization/roles;
10. accounting functionality;
11. payments functionality;
12. money/currency types;
13. workflow/state abstractions;
14. queue/event/background-job capabilities;
15. hosting/deployment platform;
16. testing framework;
17. lint/typecheck/format commands;
18. reusable components relevant to FlowPay.

Do not guess where repository inspection can provide the answer.

## Phase 2 — Map FlowPay onto QeSuite

Explain:

- which existing modules can be reused;
- what is missing;
- what should remain inside existing modules;
- what genuinely needs a new FlowPay module/capability;
- where workshop-specific code should live;
- where reusable settlement logic should live.

## Phase 3 — Propose architecture options

Propose **2 or 3 realistic architecture options** based on the actual repository.

For each option, show:

- component/module boundaries;
- end-to-end flow;
- data ownership;
- transaction boundaries;
- sync vs async steps;
- event handling;
- idempotency approach;
- rule representation/versioning;
- approval handling;
- settlement-provider abstraction;
- accounting integration;
- audit strategy;
- failure/retry strategy;
- observability needs;
- security boundaries;
- deployment implications.

For each option, clearly state:

- advantages;
- disadvantages;
- implementation complexity;
- hackathon speed;
- long-term maintainability;
- risks.

## Phase 4 — Recommend one architecture

Recommend the architecture you believe best balances:

- existing QeSuite conventions;
- hackathon delivery;
- financial correctness;
- maintainability;
- future reuse.

Do not implement the full architecture yet.

## Phase 5 — Create architecture proposal documents

Create:

- `docs/CURRENT_QESUITE_ARCHITECTURE.md`
- `docs/FLOWPAY_ARCHITECTURE_OPTIONS.md`
- `docs/FLOWPAY_RECOMMENDED_ARCHITECTURE.md`

The recommended architecture document must be marked:

**Status: Proposed — awaiting approval**

## Final response

Report:

1. what you discovered about QeSuite;
2. the 2–3 architecture options;
3. your recommended option;
4. the major tradeoffs;
5. unresolved questions;
6. the exact decisions that require approval before implementation.

Do not proceed into major implementation until the proposed architecture has been reviewed and accepted.
