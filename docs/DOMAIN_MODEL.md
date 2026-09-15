# QeSuite FlowPay Domain Model

**Status:** Accepted foundation; detailed policies remain versioned and configurable

**Date:** 2026-09-14

## Domain flow

```text
BusinessEvent
  → SettlementRuleVersion evaluation
  → ApprovalPolicyVersion enforcement
  → Settlement + SettlementDistribution(s)
  → SettlementProviderTransaction(s)
  → JournalEntry
  → ReconciliationRecord
  → AuditEvent timeline
```

The workshop module produces business facts. It does not calculate entitlement, approve settlements, call providers, or post journals.

Generic business records—Customer, Service, Job, Quote, Invoice, Payment, and job-participant assignments—belong outside FlowPay. Vehicle and workshop job-card details extend a generic Job in their own module. Payment confirmation is an audited, idempotent business transition that publishes an outbox event; a separate adapter maps the confirmed payment, invoice, and optional job status into FlowPay's versioned fact contract.

A generic Job begins in `DRAFT` and can move only through explicit commands: `DRAFT → IN_PROGRESS → COMPLETED`, or cancellation from `DRAFT`/`IN_PROGRESS` with a reason. Each transition has a stable command identity, semantic fingerprint, actor, correlation ID, timestamp, and append-only audit evidence. Database triggers reject a status mutation without its matching transition record. Job lifecycle event publication is a separate business-boundary adapter and is not implied by changing a row.

Invoice and payment authoring use exact atomic-unit amounts and explicit scales from their first persisted record. An issued invoice validates its active customer and optional same-customer job. A pending payment inherits the invoice asset/scale. The MVP intentionally accepts one full receipt equal to the invoice total; partial-receipt allocation is rejected until an exact concurrency-safe receivable-allocation model is added. Both commands are tenant-authorized, semantically idempotent, and audited; payment confirmation remains a separate controlled transition and event boundary.

Services carry an exact unit price and explicit asset precision. Quote authoring validates the active customer, optional same-customer job, and same-tenant/same-asset service references, then calculates every line and the quote total with `bigint`; a fractional quantity is accepted only when its line total is exact at the selected asset precision. Quote terms and lines are immutable after creation. Explicit `DRAFT → ISSUED → APPROVED|REJECTED|EXPIRED` transitions are append-only and database guarded. Approval emits `BUSINESS_QUOTE_APPROVED`; a business adapter records the generic `QUOTE_APPROVED` event and facts for any configured FlowPay rule without directly initiating settlement.

## Aggregates and records

### Organisation and Participant

`Organisation` is the tenant boundary. `Participant` is a generic party eligible to appear in a rule or settlement destination, with types such as contractor, supplier, referrer, employee, or internal business unit.

Cloudflare Access establishes user identity. Application users, organisation memberships, and roles in D1 establish application authority. Financial commands derive their organisation, actor, and roles from this server-side context rather than trusting client claims.

### BusinessEvent

An immutable, versioned fact produced by a business module or trusted integration.

Required identity and provenance:

- internal ID plus `(organisationId, source, externalEventId)` deduplication identity;
- event type and schema version;
- aggregate type/ID;
- occurred and recorded times;
- correlation and optional causation IDs;
- validated payload.

An event states what happened. It is not a transfer command.

Event ingestion stores a semantic replay hash covering the external event's business fields, normalized rule facts, and exact proposed settlement amount. Transport-local identifiers, recording time, and correlation metadata do not change business identity. A replay with matching meaning returns the original evaluation/settlement; a replay with different meaning is rejected as a conflict.

### SettlementRule and SettlementRuleVersion

`SettlementRule` is the stable lifecycle identity. A published `SettlementRuleVersion` is immutable and contains the trigger, typed conditions, priority/effective dates, beneficiary instructions, provider policy, approval-policy version, and authorship evidence.

New policy and rule identities begin in `DRAFT` with an immutable version 1. Activation and deactivation are explicit append-only transitions; direct parent-status edits are rejected in D1. Activation requires a different authorized reviewer from the version author. A rule cannot activate unless its referenced approval policy is active, and creation validates that all beneficiaries are active in the same organisation.

The MVP expression vocabulary is allow-listed. It must not evaluate arbitrary JavaScript or SQL.

Rule evaluation receives a validated, flattened fact map from the originating business-module adapter. It evaluates effective dates against the business event's `occurredAt` timestamp using an inclusive start and exclusive end, records pass/fail evidence for every condition, selects the highest-priority match, and reports equal-priority matches as a conflict rather than choosing silently.

### ApprovalPolicy and ApprovalPolicyVersion

The stable policy identity points to immutable policy versions. A version can describe automatic, manual, or threshold/role/count-based approval requirements. An `ApprovalRequest` snapshots the requirements for one settlement; `ApprovalDecision` is append-only and unique per request/actor.

Approval evaluation counts distinct actors, supports actors with multiple roles without counting one actor twice, enforces configured self-approval restrictions, and makes rejection explicit. Provider capability never changes these requirements.

Approval decisions use a stable decision identity and semantic fingerprint. The approval request carries an optimistic decision version; a database trigger rejects stale or closed writes so concurrent approvers are re-evaluated against current decisions. Final approval moves the settlement from `PENDING_APPROVAL` to `READY`. Rejection requires a reason, marks the request rejected, and moves the settlement to `CANCELLED`. Organisation, actor, and role claims are trusted authorization context and must be derived server-side rather than accepted from request JSON.

### Settlement

The settlement is the business-level decision to distribute one exact gross amount under one rule version and one source event. It owns:

- exact asset, amount, and calculation evidence;
- the validated state machine;
- the exact rule and approval versions;
- ordered beneficiary distributions;
- state version for optimistic concurrency;
- immutable/auditable transition evidence.

Every state change increments `stateVersion` exactly once and requires a matching append-only `SettlementStateTransition`. Database triggers enforce the allowed transition graph and reject direct status edits without transition evidence.

Unique `(sourceEventId, ruleVersionId)` prevents duplicate evaluation from creating a second settlement.

### SettlementDistribution and SettlementAttempt

A distribution is one beneficiary entitlement with exact amount, calculation evidence, and independent execution state. An attempt records one externally meaningful submission attempt and its stable idempotency key. Unknown outcomes are distinct from failures; retry cannot create a fresh transfer until the previous outcome is resolved.

Provider policy includes an explicit provider, network, and transfer method. Organisation-level provider sources and participant-level settlement destinations are resolved outside the rule calculation. This keeps beneficiary entitlement independent from wallet custody while preventing implicit network selection at execution time.

### EscrowArrangement and EscrowMilestone

Escrow is modeled first as an application-controlled business and financial workflow, not as an assumption that funds are held by a custom smart contract. An arrangement has one exact total, explicit funding/release/dispute states, and ordered milestones whose exact release amounts must sum to the arrangement total. Milestone verification is append-only evidence linked to a `BusinessEvent`; release is a separate append-only link to the resulting `Settlement`.

The arrangement inherits asset, scale, and exact amount from one tenant-scoped pending or confirmed funding payment. Those financial terms and the milestone schedule become immutable when authored. Activation moves the draft to awaiting funding; funding confirmation is allowed only after the linked payment is confirmed. Milestones are verified in order by an authorized operational actor. Each verification emits its configured generic event type (initially `MILESTONE_VERIFIED`) and exact release amount through the normal rule engine. Consequently, the selected rule's approval policy governs the payout; escrow verification itself never bypasses approval or directly calls a provider.

Settlement confirmation drives the release adapter. A verified milestone remains unreleased while its settlement is pending, submitted, failed, or otherwise unconfirmed. Only a `CONFIRMED` linked settlement creates the immutable release link and advances the arrangement to `PARTIALLY_RELEASED` or `RELEASED`.

This split lets an architecture review choose later whether custody is represented by a Circle wallet, provider account, smart contract, or another reviewed mechanism. Provider custody never substitutes for milestone verification, approval, accounting, reconciliation, or audit controls.

### SettlementProviderTransaction and ProviderEvent

Provider records preserve provider ID, network, network transaction reference, normalized status, and redacted evidence separately from the business settlement. Provider callbacks are immutable inputs deduplicated by `(provider, providerEventId)`.

Pending provider transactions are selected by a scheduled observer using a durable per-record lease and bounded exponential backoff. An interrupted submission without a provider transaction identity remains frozen as `OUTCOME_UNKNOWN`; it cannot be retried automatically. A finance operator may resume it only by recording an append-only `SettlementRecoveryDecision` asserting that the provider verified no transfer was created, including an external evidence reference. The superseded attempt is retained as terminal evidence before a new attempt receives a new idempotency identity.

### LedgerAccount, JournalEntry, and JournalLine

Accounting uses exact, double-entry lines. A posted journal is immutable and traceable to its source event, settlement/distribution, provider evidence, and posting-policy version. Corrections use linked reversals or adjustments.

A reversal is a new posted journal whose lines exactly invert the original entry and whose `reversalOfId` points to it. The original remains `POSTED`; it is never edited or deleted. At most one reversal can reference an original entry, and the finance command requires a reason, external evidence reference, stable idempotency identity, and audit event.

Principal-versus-agent treatment, recognition timing, clearing accounts, and fee policy are configuration/business-accounting decisions rather than provider behavior. The hackathon demo uses the principal presentation recorded in ADR-015; production adoption still requires jurisdiction- and contract-specific accounting review.

Journal drafts balance with exact integer arithmetic independently for every asset/scale combination. Posting identities are unique by organisation, source, and purpose and carry a semantic fingerprint. Entries are created as drafts and become posted only in the same atomic batch that inserts their validated lines. Database triggers prohibit later line mutation or deletion.

### ReconciliationRecord

Reconciliation compares expected distribution, provider-confirmed result, and accounting posting. Outcomes are pending, matched, mismatched, or explicitly resolved with actor/reason/evidence.

The initial reconciliation service binds one confirmed distribution to its provider transaction and the exact posted debit journal line representing that entitlement. Each check is retained in evidence; changed replay inputs conflict instead of rewriting the original conclusion.

A mismatch may move to `RESOLVED` only through an authorized append-only resolution carrying actor, reason, evidence reference, timestamp, and semantic fingerprint. Database triggers reject direct resolution-state mutation and preserve the original mismatch checks.

`AccountingPostingPolicyVersion` is immutable and effective-dated. The initial `SETTLEMENT_CASH_MOVEMENT_V1` policy configures the settlement-clearing debit account, digital-cash credit account, asset, and scale; it does not decide principal/agent recognition. `AccountingWorkItem` durably joins a confirmed-settlement message to one journal and all resulting distribution reconciliations.

Additional policy kinds connect the business lifecycle to accounting without hardcoded account IDs: `INVOICE_ISSUED_V1` recognizes receivable and revenue; `PAYMENT_RECEIPT_V1` recognizes cash and clears receivable; `SETTLEMENT_OBLIGATION_V1` creates expense/payable entries only for explicitly mapped beneficiaries. `SETTLEMENT_CASH_MOVEMENT_V1` may map a beneficiary to a specific debit account, supporting internal treasury transfer for the organisation share while external distributions clear payable balances.

### AuditEvent

Append-only evidence of commands, decisions, transitions, retries, failures, and links. Audit is not a replacement for aggregate state; it is the human-readable and exportable explanation of that state.

### OutboxMessage and InboxMessage

The outbox is written in the same D1 transaction as domain state. Consumers deduplicate queue delivery through inbox records. Neither transport acknowledgements nor provider idempotency replace database idempotency.

`SettlementWorkItem` is the durable handoff from a validated settlement-ready message to provider execution. Its `sourceMessageId` is unique, so duplicate queue delivery cannot schedule a second execution. Work items are provider-neutral and remain distinct from provider attempts and transactions.

## Exact money

```text
Money {
  assetCode: string
  atomicAmount: bigint
  scale: integer 0..18
}
```

JSON and D1 carry canonical base-10 integer strings. Binary floating point and D1 `REAL` are forbidden for financial amounts. Every operation requires matching asset code and scale.

Percentage instructions use integer basis points. Division rounds down initially; remaining atomic units go to an explicit remainder beneficiary or, when the rule fully allocates 10,000 basis points, by largest fractional remainder with original instruction order as the tie-breaker.

## Core invariants

1. Distribution amounts are non-negative and sum exactly to the settlement amount.
2. The same event/rule version creates no more than one settlement.
3. Every external mutation uses a persisted stable idempotency key.
4. Approval requirements are satisfied before `READY` or submission.
5. Settlement state changes use an allowed action and are audited.
6. Parent confirmation requires the configured completion condition for every distribution.
7. Provider acceptance is not provider confirmation, accounting posting, or reconciliation.
8. Posted financial history and applied rule/policy versions are immutable.
9. Every record and command is organisation-scoped.
10. Provider types and workshop concepts do not enter the reusable domain.
11. Escrow milestone amounts sum exactly to the linked funding payment when the draft is authored; financial terms and milestones are immutable thereafter.
12. A milestone release links verified evidence to one settlement and is never inferred from provider movement alone.
13. Escrow milestones verify in schedule order, and only a confirmed linked settlement advances release state.

## Persistence mapping

The migration sequence under `apps/api/migrations` defines the financial core, orchestration, identity, generic business records, workshop adapter, and provider-neutral escrow foundation. JSON columns preserve versioned rule/evidence payloads while identity, state, exact amount, ordering, and idempotency fields remain queryable and constrained columns.
