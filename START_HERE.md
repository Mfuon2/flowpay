# QeSuite FlowPay — Start Here

This repository began as a proposal-first handoff and is now the active
greenfield implementation of QeSuite FlowPay.

The architecture discovery phase is complete. The accepted direction is recorded in `docs/FLOWPAY_RECOMMENDED_ARCHITECTURE.md` and durable decisions are recorded in `docs/DECISIONS.md`.

The governing application definition is `docs/PRODUCT_CHARTER.md`. Product, architecture, implementation, and UI decisions must remain consistent with it.

## What is decided

We want to build **QeSuite FlowPay** by combining two ideas:

1. **ERP-triggered programmable settlement**
2. **Smart contractor/workshop revenue sharing**

The core product idea is:

**Business activity happens → the system verifies it → settlement rules are applied → money is distributed → accounting is updated → the full decision is auditable.**

The first demo vertical is an automotive workshop.

The workshop is not the product. It is the clearest first demonstration of a reusable settlement engine.

## What remains open

- production identity provisioning and membership administration;
- detailed accounting policy and chart-of-accounts mapping;
- final approval bands and maker-checker policy;
- production Arc/Circle custody, batching/contract, and provider choices;
- production stablecoin network/provider selection.

## Current implementation direction

FlowPay is a Cloudflare-native modular monolith with D1, a transactional outbox, Cloudflare Queues at asynchronous boundaries, exact money, immutable financial evidence, and a provider abstraction. Simulation is the deterministic fallback. ADR-016 selects Circle Developer-Controlled Wallets, individual EOA USDC transfers, and polling for the hackathon Arc Testnet adapter only; production custody/provider selection remains open and current documentation must always be rechecked.

Implementation proceeds from `docs/ROADMAP.md` in small, validated milestones.

## Local foundation and flagship data

```sh
npm install
npm run db:migrate:local
npm run db:seed:local
npm run validate
```

The seed is idempotent and creates the Metro Auto Works business, generic
participants, completed Nissan Juke job, issued USD 1,000 invoice, pending
payment, 25/70/5 rule, approval controls, provider-neutral settlement
configuration, and chart of accounts. It does not fabricate completed financial
history: confirming the pending payment must drive the real application flow.

Set `FLOWPAY_PROVIDER=simulation` only for an explicit local/demo environment.
If it is absent, ready execution work remains durably pending. Application API
access always requires a valid Cloudflare Access identity and active D1
organisation membership.

Operational handoff and rehearsal guidance is in `docs/OPERATIONS_RUNBOOK.md`,
`docs/DEPLOYMENT_CHECKLIST.md`, and `docs/DEMO_RUNBOOK.md`.
The evidence-based status and remaining external gates are tracked in
`docs/MILESTONE_COMPLETION_AUDIT.md`.

The isolated simulation deployment is available at
`https://flowpay-api.leemfo.workers.dev`. The PWA shell and health endpoint are
live. Business API routes remain fail-closed until the exact Cloudflare Access
issuer/audience and verified application memberships are configured; Circle
credentials are not present and no testnet transfer is claimed.
