# QeSuite FlowPay Implementation Roadmap

**Hackathon:** 2026-09-27 through 2026-10-10

The order follows business risk: prove financial correctness and recovery before polishing external infrastructure or UI.

## Milestone 0 — Discovery and architecture

**Status:** Complete

- Greenfield repository assessed.
- Three architecture options compared.
- Cloudflare-native modular monolith accepted.
- Arc/USDC assessed from current official sources; the technology choice was left open at discovery and later narrowed for hackathon testnet use by ADR-016.

## Milestone 1 — Provider-neutral domain foundation

**Status:** Complete

- Workspace/tooling and Worker health scaffold.
- Exact money and deterministic percentage/fixed/remainder calculation.
- Explicit settlement state transitions.
- Initial D1 financial/event/outbox schema and migration-runtime tests.
- Typed business-event, settlement-rule, approval-policy, and provider contracts.
- Deterministic simulation provider covering confirmation, delay, retryable failure, terminal failure, ambiguous accepted outcomes, and idempotency conflicts.

Exit: domain contracts are vendor/vertical independent; financial calculation/state/database invariants pass locally.

## Milestone 2 — Rule evaluation and approvals

**Status:** Complete for the foundation increment

- Complete: versioned allow-listed condition schema and evidence-producing evaluator.
- Complete: rule selection, priority, event-time effective windows, and explicit equal-priority conflict handling.
- Complete: approval bands, roles, distinct approvers, multi-role allocation, rejection, and maker-checker enforcement.
- Complete: persist immutable rule-evaluation evidence and snapshot the selected approval requirements during settlement creation.
- Complete: append idempotent approval decisions and advance settlement state through an optimistic-concurrency application service.
- Complete: preserve immutable state-transition evidence and reject arbitrary/unaudited database status mutation.
- Complete: separately authorized, idempotent manual release/cancel commands for `MANUAL` execution policies, including concurrent replay protection.
- Complete: authenticated approval-policy and settlement-rule version-1 authoring with domain validation, stable command replay, immutable versions, and active tenant/reference checks.
- Complete: database-enforced activate/deactivate lifecycles with append-only evidence and mandatory maker-checker activation by a reviewer other than the version author.

## Milestone 3 — Idempotent orchestration

**Status:** Complete for the provider-neutral MVP

- Complete: internal business-event ingestion service with stable semantic replay hashing.
- Complete: atomic D1 creation of event, evaluation, settlement, distributions, approval request, audit evidence, and outbox messages.
- Complete: no-match, equal-priority conflict, automatic approval, required approval, replay, conflict, and configuration-failure paths.
- Complete: scheduled transactional-outbox dispatch with bounded retry and explicit dispatch evidence.
- Complete: Cloudflare Queue consumer validation, inbox deduplication, permanent-failure quarantine, and idempotent creation of provider-neutral execution work.
- Complete: Cloudflare Access JWT verification and server-side active membership/role resolution.
- Complete: organisation-scoped query APIs plus permission-gated payment confirmation, approval, and manual settlement commands.
- Complete: provider-neutral individual-distribution submission with explicit source/destination/network configuration and durable attempts before external calls.
- Complete: simulation submission paths for confirmed, accepted/pending, retryable, terminal, duplicate, and ambiguous-after-acceptance outcomes.
- Complete: conservative interrupted-call recovery that freezes a started attempt as unknown rather than blindly resubmitting.
- Complete: provider status observation for pending, delayed confirmation, late failure, unchanged state, and not-found outcomes.
- Complete: parent confirmation only after every distribution confirms, plus safe resumption after an ambiguous transfer is later confirmed.
- Complete: explicitly enabled simulation execution from ready queue messages; an unconfigured provider fails closed by leaving durable work pending.
- Complete: scheduled provider-status polling with bounded selection, per-record leases, exponential backoff, and durable observation errors.
- Complete: explicit, permission-gated recovery of an unknown provider call only after an operator records provider non-submission evidence; the prior attempt remains visible and terminal.
- Complete: scheduled polling is the confirmation mechanism for the MVP. Signed callbacks remain disabled until Circle documents the exact signed bytes and signature encoding or supplies an official verifier; no verification contract is guessed.

## Milestone 4 — Accounting and reconciliation

**Status:** Complete for the provider-neutral MVP

- Complete: pure exact-money journal balance validation, including independent asset/scale buckets.
- Complete: tenant/account/asset-validated, idempotent D1 journal posting with stable semantic fingerprints.
- Complete: database-enforced immutable posted journal entries and lines.
- Complete: per-distribution provider/journal reconciliation with explicit matched/mismatched evidence.
- Complete: versioned, effective-dated accounting posting policies with deterministic equal-priority conflict handling.
- Complete: queue-triggered confirmed-settlement accounting work that posts one journal and reconciles every distribution idempotently.
- Complete: authorized, idempotent reconciliation-mismatch resolution with append-only reason/evidence and database-guarded state change.
- Complete: authorized exact journal reversal that posts inverse lines, links the original entry, preserves the original as posted history, and prevents multiple reversals.
- Complete: generic invoice-issued and payment-confirmed adapters post exact receivable, revenue, and cash entries using versioned/effective-dated policies.
- Complete: settlement creation posts only explicitly mapped beneficiary obligations; confirmed cash movement supports beneficiary-specific debit accounts while retaining a configured fallback.
- Complete: Metro Auto Works demo chart and principal presentation are recorded in ADR-015 and seeded without importing workshop semantics into accounting services.

## Milestone 5 — Arc/Circle integration spike and decision

**Status:** In progress; hackathon adapter selected, live credentialed proof pending

- Complete for the credential-free adapter spike: rechecked current Arc network, Wallets support, transfer, status, idempotency, address-validation, confirmation, entity-secret, and notification-key documentation.
- Complete: provider-neutral Circle Wallets Arc Testnet adapter maps exact scale-6 USDC transfers, UUIDv4 idempotency, address validation, retry classes, and `COMPLETE`-only confirmation without runtime credentials.
- Complete: provider execution now persists its UUIDv4 attempt identity as the external idempotency key.
- Complete: the pinned official Circle developer-controlled-wallet SDK manages fresh entity-secret ciphertext, passes adapter tests, and bundles in the Cloudflare Worker runtime.
- Complete: explicit `circle-wallets` Worker selection uses secret bindings, fails closed on missing configuration, executes individual distributions, and confirms by scheduled polling.
- Complete: ADR-016 selects this path only for the hackathon Arc Testnet adapter; provider-neutral architecture, simulation fallback, and production review remain mandatory.
- Next: credentialed live low-value Wallets EOA transfer and fee evidence. No credentials are currently present, so this cannot be represented as verified.
- Next: compare Wallets SCA atomic batch and Circle Mint sandbox access with actual account eligibility.

## Milestone 6 — Workshop vertical and acceptance flow

**Status:** Complete for the hackathon vertical slice

- Complete: generic customer, service, job, quote, invoice, payment, and participant-assignment persistence foundation.
- Complete: workshop vehicle/job-detail extension isolated from generic business and FlowPay tables.
- Complete: idempotent payment confirmation with an audited state transition and transactional business outbox message.
- Complete: queue adapter from `BUSINESS_PAYMENT_CONFIRMED` to the generic versioned FlowPay event and validated rule facts.
- Complete: completed-job match and incomplete-job no-match integration paths.
- Complete: authenticated read APIs for customers, jobs, invoices, payments, settlements, journals, reconciliations, dashboard summaries, and settlement audit detail.
- Complete: idempotent Metro Auto Works seed kept outside production migrations.
- Complete: $1,000 → $250/$700/$50 acceptance journey from pending payment through approval, provider execution, accounting, reconciliation, and audit.
- Complete: authenticated, idempotent customer and participant authoring commands with audit evidence.
- Complete: exact service catalog and multi-line quote authoring, immutable terms, guarded issue/approval/rejection/expiry transitions, and generic `QUOTE_APPROVED` event adaptation.
- Complete: authenticated job authoring plus database-enforced, append-only draft → in-progress → completed/cancelled lifecycle evidence.
- Complete: authenticated, exact, idempotent issued-invoice and pending-payment authoring with tenant/reference validation and audit evidence.
- Complete: job start/completion/cancellation publish transactional business outbox events without importing FlowPay/provider logic.
- Complete: invoice paid/void lifecycles are database-enforced and audited; voiding requires a reason and refuses invoices with recorded payments.
- Explicit MVP constraint: one full receipt per invoice; partial receipts remain rejected until exact concurrent allocation is implemented.
- Complete: duplicate, retryable, terminal, pending, and ambiguous failure demonstrations exercise the same provider-neutral execution path.
- No workshop type imported by FlowPay core.

### Escrow foundation

- Complete: provider-neutral exact milestone allocation and explicit arrangement state machine.
- Complete: D1 arrangements, milestones, append-only verification evidence, release-to-settlement links, and audited transition constraints.
- Complete: idempotent, authenticated authoring plus explicit activation, confirmed-funding, dispute, resolution, and cancellation commands.
- Complete: ordered milestone verification emits a generic versioned business event into the existing rule, approval, settlement, accounting, reconciliation, and audit pipeline.
- Complete: a milestone is marked released only after its linked settlement reaches `CONFIRMED`; partial and final release transitions are append-only and exact.
- Complete: tenant-scoped escrow detail API and business-facing authoring, funding, dispute, verification, settlement-status, transition, and audit controls.
- Deferred: onchain custody or smart-contract escrow requires a separate future business, security, and architecture decision; it is not part of the hackathon MVP.

## Milestone 7 — Business-facing PWA

**Status:** Complete for the hackathon MVP

- Complete: responsive PWA shell, overview, tenant-scoped business and financial collections, and installable service worker.
- Complete: settlement list and flagship detail with rule, distributions, approval controls, provider evidence, accounting, reconciliation, and audit timeline.
- Complete: payment-confirmation control that enters the event-driven workflow through the business boundary.
- Complete: customer, participant, draft-job, issued-invoice, and pending-payment authoring plus controlled job/payment actions.
- Complete: business-facing Products/Services and Quotes modules support exact reusable pricing, multi-line proposals, and controlled quote issue/approval/rejection.
- Complete: provider/network evidence is secondary to business terminology.
- Complete: approval-policy authoring and maker-checker lifecycle controls are available in the business-facing PWA.
- Complete: structured settlement-rule authoring in the PWA with generic business facts, dynamic participants, deterministic percentage/remainder instructions, active policy selection, and provider-neutral routing.
- Complete: issued invoices expose a reason-required void control; invoice payment remains driven only by confirmed full receipt.
- Complete: job cancellation UI requires and records explicit evidence before the lifecycle transition.
- Complete: escrow authoring and flagship evidence UI expose business funding, ordered milestones, verification, settlement, release, disputes, and audit without requiring blockchain terminology.
- Complete: finance users can resolve visible reconciliation mismatches and post reason/evidence-backed journal reversals from the PWA without mutating original evidence.
- Complete: finance users have a tenant-scoped Operations view and evidence-gated unknown-submission recovery control.

## Milestone 8 — Demo hardening

**Status:** In progress; isolated Cloudflare deployment complete, credentialed rehearsal pending

- Complete: extensive role/maker-checker and cross-organisation API tests, including tenant-scoped operations visibility.
- Complete: business-facing Operations view for outbox backlog, stale approvals, unknown/pending provider work, failed settlement/accounting work, reconciliation mismatches, and tenant-owned queue quarantine.
- Complete: finance-only unknown-submission recovery UI preserves the no-blind-retry control and requires provider non-submission evidence.
- Complete: isolated deterministic Metro seed and simulation success, retryable, terminal, pending, duplicate, and ambiguous outcome coverage.
- Complete: deployment checklist, incident/recovery runbook, three-minute demo script, rehearsal matrix, simulation fallback, and explicit testnet disclosure.
- Complete: least-privilege GitHub Actions validation runs the pinned install and full repository gate on main pushes and pull requests.
- Complete: final Worker startup profiling measured a 632.66 KiB bundle (121.12 KiB gzip) and 11.4 ms active local startup time; Cloudflare reported 10 ms for the deployed Worker.
- Complete: isolated `flowpay` D1, `flowpay-events`, `flowpay-events-dlq`, and `flowpay-api` resources are live; all 24 migrations, an idempotent two-pass demo seed, public health/PWA smoke tests, and unauthenticated API rejection are verified.
- Pending external setup: configure the exact Cloudflare Access application and enrolled D1 identities, provide Circle test credentials and wallet/token mappings, perform and record the selected Arc Testnet low-value happy path, then execute the rehearsal checklist.

## Schedule guardrails

- By 2026-09-26: foundation, rule, approval, and simulation happy/failure paths.
- By 2026-10-02: accounting/reconciliation and Circle/Arc decision/spike complete.
- By 2026-10-07: flagship UI and end-to-end demo frozen except fixes.
- 2026-10-08 through 2026-10-10: rehearsals, evidence, resilience, and submission.
