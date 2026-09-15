# QeSuite FlowPay Detailed Architecture

**Status:** Accepted foundation

**Date:** 2026-09-14

This document turns the accepted recommendation into implementation contracts. See `FLOWPAY_RECOMMENDED_ARCHITECTURE.md` for rationale and the Arc/USDC assessment.

## Runtime topology

- React/TypeScript PWA for business users.
- One Cloudflare Worker composition root for HTTP, queue, and scheduled entrypoints.
- One D1 database initially, with strict organisation and module ownership.
- Cloudflare Queues across asynchronous financial/provider/accounting boundaries.
- Transactional outbox for reliable publication and inbox records for consumer deduplication.
- Scheduled recovery for stranded outbox messages and stale provider transactions.
- Simulation and external providers behind the same server-side port.

## Module boundaries

| Module           | Commands / responsibility                                            | Publishes or returns                |
| ---------------- | -------------------------------------------------------------------- | ----------------------------------- |
| Business events  | Ingest and deduplicate verified facts                                | `BusinessEventRecorded.v1`          |
| Rules            | Draft, validate, publish, select, and evaluate immutable versions    | evaluation result/evidence          |
| Approvals        | Create requests, append decisions, verify thresholds/roles           | `ApprovalSatisfied.v1` or rejection |
| Settlements      | Calculate distributions and enforce state transitions                | provider submission command         |
| Provider adapter | Validate destination, submit idempotently, normalize status/callback | provider result/status event        |
| Accounting       | Apply versioned posting policy and post balanced journal             | journal-posted result               |
| Reconciliation   | Compare expected/provider/accounting truth                           | matched/mismatch/exception result   |
| Audit            | Append redacted decision and transition evidence                     | audit timeline query                |

Cross-module mutations go through application services, not direct table access from another module.

The generic business persistence boundary contains customers, services, jobs, participant assignments, quotes, invoices, and payments. Workshop vehicles and job-card details are isolated extension tables. Services and quotes use exact prices, application-calculated lines, idempotent commands, immutable commercial terms, and guarded quote transitions. Quote approval emits `BUSINESS_QUOTE_APPROVED`; confirming a payment emits `BUSINESS_PAYMENT_CONFIRMED` while also appending its status transition and updating a fully paid invoice. Queue adapters load organisation-scoped operational facts and invoke FlowPay event ingestion; they never calculate a split or call a provider.

## HTTP API contract

`GET /api/health` is public. Authenticated `/api/v1` routes expose tenant-scoped collections and idempotent commands for customers, participants, services, jobs, quotes, invoices, payments, approval policies, settlement rules, settlements, escrow, journals, reconciliation, audit, and operations. Quote/job/invoice/payment/escrow/configuration lifecycles use named transition endpoints; approvals, manual settlement control, unknown-outcome recovery, journal reversal, and reconciliation resolution each use dedicated evidence-bearing commands. There is no generic status `PATCH` endpoint.

Circle callbacks are deliberately absent until the exact official signed-message contract can be implemented. Provider confirmation currently uses authenticated scheduled polling.

Mutating APIs accept a caller request ID where appropriate, authenticate the actor, enforce organisation/role scope, and return existing resource identity on duplicates. State is never changed through a generic PATCH status endpoint.

The implemented `/api/v1` boundary validates the Cloudflare Access `Cf-Access-Jwt-Assertion` using the configured team-domain JWKS, issuer, and application audience. It resolves token subject/email to an active user, organisation membership, and database roles. A client selects an organisation, but that selection becomes authoritative only after membership validation. Mutation bodies cannot supply actor, tenant, role, or permission claims. Health remains public; v1 fails closed when Access configuration or authentication is absent.

Authenticated queries cover dashboard summaries, customers, services, jobs, quotes, invoices, payments, settlements, journal entries, reconciliations, operations, and the complete settlement detail/audit projection. Financial mutations require an `Idempotency-Key` header and route-specific server-derived roles.

## Event and command envelope

```text
messageId
messageType
schemaVersion
organisationId
aggregateType / aggregateId
occurredAt
correlationId / causationId
payload
```

Initial logical contracts:

- `BusinessEventRecorded.v1`
- `SettlementEvaluationRequested.v1`
- `ApprovalSatisfied.v1`
- `SettlementSubmissionRequested.v1`
- `ProviderStatusObserved.v1`
- `AccountingPostingRequested.v1`
- `ReconciliationRequested.v1`

Messages carry IDs and necessary immutable facts/references, not unbounded aggregate snapshots or secrets. Consumers validate schema version and organisation scope before side effects.

The internal event-ingestion application service computes a canonical SHA-256 replay hash from the external event's business meaning, validated rule facts, and exact settlement amount. Reusing the same organisation/source/external-event identity returns the original result only when this hash matches; different business data is an explicit conflict. A D1 `batch()` atomically persists the event, rule evaluation, settlement/distributions where matched, approval snapshot, audit evidence, and outbox messages. The service is not exposed as a public mutation route until authentication and organisation-scoped authorization are implemented.

Approval decisions use an approval-request decision version enforced by D1 triggers. Each decision batch inserts the append-only decision, advances the request version, optionally resolves the request, records the settlement transition, updates the settlement with optimistic state/version predicates, and appends audit/outbox evidence. A stale concurrent batch rolls back and is retried against current decisions. Settlement state triggers require both an allowed transition and a matching append-only transition record.

Manual policies use a separate permission-gated release/cancel command. Its stable command identity and semantic fingerprint make sequential and concurrent retries collapse into one transition. Permission claims remain trusted internal context until the HTTP authentication boundary exists.

## SettlementProvider port

```ts
interface SettlementProvider {
  validateDestination(input: DestinationInput): Promise<DestinationResult>;
  quoteFees?(input: FeeQuoteInput): Promise<FeeQuote>;
  submitTransfer(input: {
    idempotencyKey: string;
    source: ProviderSource;
    destination: ProviderDestination;
    amount: SerializedMoney;
    correlationId: string;
  }): Promise<SubmissionResult>;
  getTransaction(input: ProviderLookup): Promise<ProviderStatusResult>;
  verifyAndNormalizeCallback(request: Request): Promise<ProviderEventResult>;
}
```

Internal results distinguish accepted, pending, confirmed, rejected, retryable failure, terminal failure, and outcome unknown. Provider SDK models and credentials stay inside the adapter.

Every rule provider policy identifies the provider, network, and execution method explicitly. Organisation provider sources and participant destinations are separate configuration records. The executor resolves those records before claiming work and persists a distribution attempt plus stable UUIDv4 idempotency key before calling the provider. The external key is the immutable attempt identity, making it compatible with providers that require UUIDv4 while distribution/attempt uniqueness remains the semantic guard. Accepted transactions are stored independently from settlement state. Explicit retryable failures schedule another attempt; terminal failures remain visible; exceptions, interrupted calls, and ambiguous acceptance freeze execution as `OUTCOME_UNKNOWN` pending status recovery.

The simulation adapter is first and deterministically models immediate confirmation, pending acceptance, retryable/terminal failure, delayed state changes, idempotent replay, and ambiguous timeout after acceptance. Its transaction identity is derived from the stable transfer key, so separate runtime instances cannot collide or change logical identity.

## Transaction and queue behavior

1. Validate and authorize the command.
2. In one D1 transaction/batch, mutate owned state, append audit evidence, and insert an outbox row.
3. Dispatch to a queue; duplicate queue delivery is expected.
4. Claim the message with unique `(consumerName, messageId)` inbox identity.
5. Commit the consumer's state/audit/next-outbox work before acknowledging.
6. Persist provider key/attempt before making the external request.
7. On timeout, query by stable key/reference and block blind resubmission.

Queue delivery is at least once. Exactly-once financial effect comes from domain/database/provider idempotency working together.

The implemented Worker runs a scheduled outbox dispatcher and a `flowpay-events` queue consumer. The dispatcher records attempts, errors, and exponential backoff without deleting source messages. The consumer validates the v1 envelope, records `(consumer, message)` inbox completion, and turns `FLOWPAY_SETTLEMENT_READY` into one provider-neutral `EXECUTE_SETTLEMENT` work item. Invalid envelopes are acknowledged only after an append-only operational failure record is written; transient failures are retried and ultimately route to the configured dead-letter queue.

## Accounting integration

Settlements request posting through an accounting application service. A versioned policy returns a complete balanced draft; validation and posting are atomic. The posting identity is unique by organisation, source, and purpose.

The accounting module must preserve:

- exact debit/credit lines and asset scale;
- source event, settlement/distribution, and provider references;
- policy version and effective/posting dates;
- immutable `POSTED` state;
- reversal/adjustment links for corrections.

No infrastructure code chooses revenue recognition or principal/agent treatment. Those mappings need explicit accounting approval and tests.

The implemented accounting core validates journals with exact `bigint` arithmetic per asset/scale bucket, verifies every account against organisation and precision, and atomically inserts a draft, its lines, the posted transition, audit evidence, and an outbox message. A stable semantic fingerprint makes sequential and concurrent posting retries idempotent. D1 triggers prevent direct creation of posted entries, later line changes, and deletion of financial history.

Distribution reconciliation compares the confirmed entitlement to its exact provider transaction record and one posted debit journal line. It records every individual check—including provider ownership/status/reference, journal state, direction, asset, scale, and amount—as matched or mismatched evidence. Posting-account selection and principal/agent treatment remain versioned policy decisions rather than infrastructure defaults.

The authenticated finance Operations projection derives tenant-scoped counts and oldest-record timestamps from durable outbox, approval, attempt, provider-transaction, settlement-work, accounting-work, reconciliation, and queue-quarantine records. It exposes no credentials or raw provider authorization payloads. Unknown submission attempts link back to settlement detail, where an authorized retry remains impossible until finance records a provider non-submission reference and reason.

`FLOWPAY_SETTLEMENT_CONFIRMED` creates one durable accounting work item through the queue inbox transaction. The accounting orchestrator selects one effective highest-priority immutable policy version, rejects equal-priority ambiguity, posts one debit line per distribution plus the configured balancing cash credit, and reconciles each distribution. A crash between stages is safe because the journal and each reconciliation have independent stable identities; duplicate queue delivery resumes or returns the completed result.

## Failure and recovery

| Failure class                             | Required behavior                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| Validation/rule conflict                  | No provider call; visible rejected evaluation evidence                      |
| Approval rejection                        | Terminal for that request; auditable decision                               |
| Retryable infrastructure/provider failure | Persist attempt and bounded retry using the same external idempotency key   |
| Ambiguous external outcome                | Mark unknown, freeze resubmission, query/reconcile, escalate if unresolved  |
| Terminal provider failure                 | Preserve normalized/redacted reason; explicit retry/new attempt policy      |
| Partial distributions                     | Preserve each beneficiary truth; parent exception; authorized recovery only |
| Accounting/reconciliation failure         | Preserve provider truth and retry downstream work independently             |
| Dead letter/stale state                   | Create visible operational exception and audit recovery action              |

## Architecture enforcement

- Domain packages have no Cloudflare, Circle, React, or workshop dependencies.
- Provider packages depend inward on the provider contract; the domain never imports provider SDKs.
- Business verticals publish generic events and do not import settlement internals.
- Database access is organised by table-owning module.
- Architecture/import tests will enforce these directions as packages are added.

## Known open gates

- Identity/authentication and memberships.
- Rule condition schema and validation library.
- Final approval bands and role policy.
- Accounting treatment and chart of accounts.
- Circle/Arc implementation decision after the documented spike.
- Frontend framework/deployment details within the accepted React/PWA direction.
