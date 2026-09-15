# QeSuite FlowPay Testing and Acceptance

## Commands

```text
npm run format:check
npm run lint
npm run typecheck
npm test
npm run db:migrate:local
npm run deploy:check
npm run validate
```

`.github/workflows/validate.yml` runs `npm ci` and the complete validation gate on pull requests and main-branch pushes with read-only repository permissions.

Worker/D1 tests use the current Cloudflare Vitest plugin and apply the actual migration files inside the Workers runtime.

## Required test layers

- Pure domain tests for money, calculation, rule evaluation, approvals, and state machines.
- D1 integration tests for constraints, transactions, migrations, append-only triggers, and idempotency.
- Queue/outbox integration tests for duplicate delivery and recovery.
- Queue tests for automatic/manual ready publication, outbox dispatch failure/backoff, inbox deduplication, execution-work uniqueness, and permanent-message quarantine.
- Provider contract tests shared by simulation and external adapters.
- Circle SDK adapter tests for exact scale-6 conversion, UUIDv4 request identity, Arc destination validation, terminal-state mapping, retry classification, and not-found status recovery.
- Provider environment tests proving explicit selection, no-provider pending behavior, and fail-closed partial Circle configuration.
- Provider-executor integration tests for persisted pre-call attempts, stable identities, immediate confirmation, pending acceptance, explicit retry scheduling, terminal failure, ambiguous acceptance, and completed-work replay.
- Provider-observation tests for scheduled selection, overlapping-run leases, exponential backoff, delayed confirmation, late failure, not-found outcomes, and durable errors.
- Operator-recovery tests for unknown-call freeze, mandatory provider non-submission evidence, stable decision replay, changed-evidence conflict, append-only decisions, and safe creation of a fresh attempt.
- Accounting/reconciliation integration tests.
- Accounting tests for huge exact values, per-asset balance, zero/unbalanced rejection, concurrent posting replay, semantic conflicts, immutable posted lines, exact matches, and visible mismatches.
- Accounting orchestration tests for confirmed-message work creation, versioned policy selection, deterministic journal construction, all-distribution reconciliation, and completed-work replay.
- API authorization and cross-organisation isolation tests.
- Access tests for cryptographic signature, issuer/audience, subject/email, membership, roles, invalid tokens, and cross-organisation denial.
- Approval tests for maker-checker, role eligibility, distinct/multi-role allocation, changed retries, concurrent decisions, rejection, and unaudited state-mutation prevention.
- Configuration-authoring tests for policy bands, rule conditions/distributions, tenant references, immutable versions, idempotent creation, activation ordering, maker-checker review, append-only transitions, and direct-status-mutation prevention.
- Authenticated configuration API tests for runtime JSON parsing, role enforcement, self-activation rejection, reviewer activation, and valid generic rule publication.
- End-to-end flagship acceptance test.
- Business-boundary tests for concurrent payment confirmation, changed retries, unaudited status mutation, completed-job rule match, incomplete-job no-match, and duplicate event-adapter delivery.
- Job-command tests for concurrent creation replay, changed-command conflict, tenant/customer validation, authorized API access, allowed lifecycle transitions, required cancellation evidence, append-only transition history, and direct-mutation prevention.
- Invoice/payment authoring tests for exact values beyond JavaScript's safe integer range, concurrent replay, changed-command conflict, customer/job tenant consistency, invoice bounds, and audit evidence.
- Invoice lifecycle tests for full-payment transition evidence, direct mutation prevention, reason-required voiding, payment-aware void refusal, and append-only history.
- Job lifecycle tests assert transactional `BUSINESS_JOB_STARTED`, `BUSINESS_JOB_COMPLETED`, and `BUSINESS_JOB_CANCELLED` outbox publication.
- Commercial catalog tests cover exact service prices, multi-line/fractional quote arithmetic, values beyond JavaScript safe integers, idempotent API commands, tenant/service references, immutable terms, guarded quote transitions, approval outbox publication, and generic `QUOTE_APPROVED` adaptation.
- Escrow domain/integration tests cover exact milestone totals, valid and invalid arrangement transitions, immutable schedules, append-only verification/release evidence, ordered verification, generic rule matching, provider settlement, and release only after confirmation.
- Authenticated escrow API tests cover finance-role authoring/funding, operational verification, stable command replay, evidence retrieval, forbidden roles, and cross-organisation isolation.
- Accounting correction tests cover exact inverse journal lines, linked single reversal, unchanged original history, stable replay, changed-evidence conflict, append-only reconciliation resolution, direct-mutation prevention, and finance-role API enforcement.
- Business-accounting tests cover transactional invoice-event publication, invoice receivable/revenue posting, confirmed-payment cash/receivable posting, stable replay, mapped external settlement obligations, and deliberate omission of unmapped internal beneficiaries.

## Financial acceptance matrix

- Values above `Number.MAX_SAFE_INTEGER` round-trip exactly.
- Decimal/exponent/negative/non-canonical atomic strings are rejected.
- Percentage, fixed, remainder, zero, and awkward-rounding cases are deterministic.
- Distribution sum always equals gross amount.
- Every allowed state transition succeeds; every other pair fails.
- Duplicate event/rule/message/provider callback/posting identities create no duplicate effect.
- Retryable, terminal, ambiguous, delayed, duplicate, and partial provider outcomes remain visible.
- Journal debits equal credits by asset/scale; duplicate posting is harmless; corrections reverse/adjust.
- Reconciliation detects amount, asset, destination, provider-reference, and journal mismatches.
- Escrow funding equals the immutable milestone schedule exactly; milestones verify in order and remain unreleased until their linked settlement confirms.
- Posted corrections use balanced linked reversals, and reconciliation exceptions require explicit reason/evidence rather than overwriting the original mismatch.

## Flagship scenario

Given a completed job, a confirmed payment of 100,000 USD atomic units at scale 2, and an active rule version with workshop 2,500 bp, mechanic 7,000 bp, and referrer 500 bp:

1. exactly one settlement is created;
2. results are 25,000 / 70,000 / 5,000 atomic units;
3. required approval is enforced before provider submission;
4. provider execution is idempotent and independently evidenced;
5. a balanced journal is posted once;
6. reconciliation reaches matched or exposes a specific exception;
7. audit explains trigger, conditions, rule version, calculation, approval, transfer, journal, retries, and reconciliation;
8. replaying every input produces no duplicate transfer or journal.

## MVP release gate

No MVP is accepted with skipped tests for calculation/rounding, state transitions, provider idempotency, posting balance/uniqueness, or the end-to-end duplicate replay. External testnet availability may not be the only demo path.
