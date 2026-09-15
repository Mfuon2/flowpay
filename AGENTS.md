# QeSuite FlowPay — Codex Guidance

## Project status

QeSuite FlowPay is currently at the **product proposal and architecture discovery stage**.

The product concept is agreed.

The software architecture is **not yet finalized**.

Do not treat any conceptual diagrams in the documentation as final architecture.

Do not begin a large implementation before first inspecting the existing QeSuite codebase and proposing architecture options.

---

## Product concept

FlowPay combines:

1. **ERP-triggered programmable settlement**
2. **Smart contractor/workshop revenue sharing**

The core business idea is:

**Business Event → Rules/Conditions → Approval/Control → Settlement → Accounting → Reconciliation → Audit**

The exact technical implementation of that flow is not yet decided.

---

## Hackathon intent

FlowPay is intended for an accounting/ERP stablecoin hackathon.

The hackathon demonstration should show how an ERP can connect verified business events to programmable settlement.

The first vertical is an automotive workshop.

Example:

A customer pays $1,000 for a completed job.

Agreement:

- Workshop: 25%
- Mechanic: 70%
- Referrer: 5%

Once business conditions are satisfied, FlowPay should be able to calculate and execute or simulate the settlement, update accounting, and preserve a clear audit trail.

---

## Important product distinction

The workshop is a demonstration vertical.

Do not design the core product as a garage application.

Do not hardcode terms like `Mechanic` or `Vehicle` into the reusable settlement engine unless they belong to a workshop-specific layer.

The reusable core should support future use cases such as:

- suppliers;
- contractors;
- construction milestones;
- consultants;
- commissions;
- salons;
- marketplaces;
- procurement;
- usage-based settlement.

---

## User-facing philosophy

This should look like business software, not a crypto product.

Prefer:

- Jobs
- Invoices
- Payments
- Settlements
- Rules
- Approvals
- Accounting
- Audit

Avoid making users think in terms of:

- Web3
- DeFi
- token mechanics
- blockchain internals

Stablecoins are part of the settlement infrastructure, not the product identity.

---

## Financial principles already agreed

These are product/engineering constraints, not full architecture decisions:

- money calculations must be exact;
- duplicate events must not create duplicate financial execution;
- accounting must be traceable;
- important financial decisions must be auditable;
- historical financial meaning should not be silently rewritten;
- secrets must never be committed;
- provider-specific logic should not dominate the business domain;
- automated settlement must respect approvals/controls.

How these principles are implemented is still an architecture decision.

---

## Architecture rule

Before major FlowPay implementation, Codex must first:

1. inspect the repository;
2. describe the current QeSuite architecture;
3. identify reusable modules and constraints;
4. identify whether QeSuite already has:
   - eventing;
   - queues;
   - accounting abstractions;
   - payment abstractions;
   - money types;
   - auth/roles;
   - workflow/state-machine concepts;
5. propose 2–3 viable FlowPay architectures;
6. explain tradeoffs;
7. recommend one.

The architecture should be chosen based on the real QeSuite codebase, not invented in isolation.

---

## Do not assume

Do not assume FlowPay must use:

- a separate service;
- an event bus;
- Cloudflare Queues;
- Durable Objects;
- a monorepo package;
- a specific database schema;
- a specific blockchain SDK;
- a specific rule engine structure;
- a particular accounting integration pattern.

These are all open questions until repository discovery is complete.

---

## Engineering workflow

For the first Codex session:

- inspect;
- document;
- propose;
- compare;
- recommend.

Do not make broad implementation changes unless explicitly asked after the architecture is chosen.

Small exploratory changes are acceptable only if needed to understand the repo and are clearly identified.

---

## Primary documents

Read:

- `START_HERE.md`
- `docs/HACKATHON_PROPOSAL.md`
- `docs/PRODUCT_REQUIREMENTS.md`
- `docs/DEMO_SCENARIO.md`
- `docs/OPEN_ARCHITECTURE_QUESTIONS.md`
- `docs/ARCHITECTURE_DECISION_TEMPLATE.md`

Then execute:

`codex-prompts/00_DISCOVER_AND_DESIGN_ARCHITECTURE.md`
