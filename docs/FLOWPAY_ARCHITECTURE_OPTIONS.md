# FlowPay Architecture Options

**Status:** Reviewed — Option B accepted on 2026-09-13

**Date:** 2026-09-13

## Evaluation context

FlowPay is greenfield. The options below are therefore compared against the product requirements rather than an existing implementation. All three preserve the same domain boundary:

```text
Business modules
    → immutable BusinessEvent
    → FlowPay rule evaluation and approvals
    → settlement orchestration
    → provider adapter
    → accounting and reconciliation
    → append-only audit
```

The workshop is a demonstration module that produces generic event facts and participant references. The reusable core never assumes that a beneficiary is a mechanic, workshop, or referrer.

## Common invariants

Every viable option must implement these controls:

- Monetary amounts are stored as integer atomic units plus currency/asset and explicit scale. API JSON serializes amounts as decimal strings or integer strings, never binary floating-point values.
- Percentages use integer basis points for the MVP. Calculation applies a documented rounding mode, allocates deterministic residual units, and verifies that distributions equal the settlement total.
- Each inbound event has a stable globally unique ID and source. A database uniqueness constraint prevents a duplicate settlement candidate for the same event and rule version.
- Each provider submission has a stable idempotency key derived from the settlement/distribution identity and attempt policy. Provider transaction references are separate from business settlement IDs.
- Each webhook/provider update has a stable provider event ID and is deduplicated before state mutation.
- Each accounting posting has a unique source reference and balanced debit/credit lines. Posted entries are reversed, never edited.
- Settlement statuses change only through named transition operations with audit records.
- An approval decision records actor, role, decision, time, and policy/rule version. Execution cannot bypass an unsatisfied policy.
- Secrets and provider credentials exist only in server-side secret bindings.
- Audit events are append-only and contain correlation IDs spanning event, settlement, provider, journal, and reconciliation records.

## Option A — Synchronous modular monolith with a D1 job table

### Component/module boundaries and deployment

- One React PWA.
- One Cloudflare Worker API organized into strict domain modules.
- One D1 database containing module-owned tables.
- No queue or workflow product initially.
- A scheduled Worker retries due jobs and polls submitted provider transactions.
- Simulation and Circle/Arc implementations sit behind `SettlementProvider`.

Suggested internal modules:

```text
apps/web
apps/api
packages/domain
  ├── identity
  ├── organisations
  ├── business-events
  ├── rules
  ├── approvals
  ├── settlements
  ├── accounting
  ├── reconciliation
  └── audit
packages/providers
  ├── contract
  ├── simulation
  └── circle-arc
packages/workshop-demo
```

### End-to-end flow

1. A business command records the business fact and immutable event.
2. The API evaluates applicable rule versions and creates either a pending approval or ready settlement in one database transaction.
3. An automatic/satisfied settlement is put in a D1-backed `settlement_jobs` table.
4. The request may run the simulation provider immediately; real external submission is performed by a job processor after the originating transaction commits.
5. Provider callbacks or scheduled polling update the provider transaction and settlement state idempotently.
6. Confirmation posts the journal entry and reconciliation record in a database transaction.
7. Each step appends an audit event.

### Data ownership and transaction boundaries

Modules share one database but own their tables and writes. Local transitions that must be atomic use a D1 transaction/batch. The external provider call is never inside a database transaction. A lease/claim field on the job row prevents concurrent processors from intentionally handling the same due job, while idempotency protects against lease expiry and retry races.

### Rules and approvals

Rules use normalized identity/status/effective-date columns plus an immutable version payload for conditions and beneficiaries. Activating a change creates a new version. Approval requests snapshot the applicable policy and required approver counts.

### Failures and retries

- Due jobs use attempt count, next-attempt time, last error code/message, and a terminal/dead status.
- Exponential backoff is explicit in application code.
- Ambiguous provider timeouts enter an `UNKNOWN`/reconciliation-required condition; they are queried by idempotency key before any resubmission.
- A scheduled handler recovers abandoned leases and retries eligible jobs.

### Observability and security

Structured logs contain correlation IDs, operation names, attempt counts, and state transitions, but no secrets or full wallet credentials. Operational views expose stuck, failed, and ambiguous settlements. Authentication, organisation-scoped authorization, approval permissions, and maker-checker rules remain server-enforced.

### Advantages

- Smallest infrastructure surface and fastest initial implementation.
- All authoritative records can be inspected in one database.
- Easy local development and deterministic integration testing.
- Avoids premature distributed services.

### Disadvantages

- Reimplements queue behavior, leases, retries, and dead-letter handling in D1.
- Scheduled recovery increases settlement latency and operational code.
- Backpressure and isolation are weaker than a managed queue.
- Long-running provider reconciliation becomes awkward.

### Assessment

| Dimension                 | Rating                                                     |
| ------------------------- | ---------------------------------------------------------- |
| Implementation complexity | Low–medium                                                 |
| Hackathon speed           | Excellent                                                  |
| Financial safety          | Good if job/idempotency controls are complete              |
| Long-term maintainability | Medium                                                     |
| Primary risk              | A “simple” job table grows into a fragile home-built queue |

## Option B — Modular monolith with transactional outbox and Cloudflare Queues

### Component/module boundaries and deployment

- One React PWA.
- One primary Cloudflare Worker deployment containing the API and queue/scheduled handlers, separated internally by domain module.
- One D1 database for the MVP, with explicit table ownership and a migration path to per-organisation partitioning if scale later requires it.
- A transactional outbox in D1.
- Cloudflare Queues for asynchronous rule evaluation, settlement submission, provider-status handling, accounting posting, reconciliation, and recovery notifications.
- A scheduled outbox dispatcher/reconciler as a safety net.
- No Durable Object or Workflow in the initial MVP unless evidence demonstrates a need.

### End-to-end flow

```text
Business command/API
  → D1: business fact + BusinessEvent + outbox row (atomic)
  → outbox dispatcher
  → Queue: business-event-recorded
  → rule evaluator
  → D1: evaluation evidence + settlement + approval request/outbox (atomic)
  → approval API or automatic policy
  → Queue: settlement-ready
  → provider orchestrator
  → SettlementProvider.submit(idempotencyKey)
  → D1: attempt/provider transaction/state/audit
  → webhook or polling result
  → Queue: provider-status-received
  → confirmation transition
  → Queue: accounting-posting-requested
  → balanced journal + reconciliation + audit
```

The dispatcher publishes committed outbox rows. Publishing immediately after commit is an optimization; a scheduled sweep republishes any undispatched rows. Consumers assume at-least-once delivery and deduplicate in D1.

### Data ownership and transaction boundaries

Each module owns tables and exposes application services. The initial single D1 database permits atomic business fact/event/outbox writes and atomic state/audit/outbox transitions. Provider calls occur after committing `SUBMITTING`/attempt data and never participate in a database transaction. Consumer acknowledgements happen only after durable local work succeeds.

### Event handling and idempotency

An envelope contains event ID, type, schema version, organisation ID, aggregate reference, occurred/recorded times, correlation/causation IDs, and a typed payload. Consumer inbox rows have a unique `(consumer, message_id)` key. Domain constraints additionally enforce semantic uniqueness, such as `(source_event_id, rule_version_id)` and unique provider idempotency keys.

The outbox/inbox pattern prevents “database committed but message lost” from becoming an invisible failure and makes replay observable. It does not claim exactly-once delivery; business effects are exactly-once-by-invariant under duplicate delivery.

### Rules and approvals

Rule identity and lifecycle fields are relational. Each immutable rule version contains:

- trigger type and schema version;
- effective interval and priority;
- versioned conditions;
- versioned beneficiaries/calculation instructions;
- provider/method policy;
- approval policy reference/version;
- activation metadata.

Conditions use a deliberately small typed expression vocabulary for the MVP, not executable user code or a general workflow language. Evaluation persists input facts, condition outcomes, calculation steps, rounding/residual allocation, and the exact rule version.

Approval policies support `AUTOMATIC`, `MANUAL`, and threshold-based required approvals. The approval service validates role, organisation scope, self-approval/maker-checker rules, uniqueness of each decision, and required counts before emitting `SETTLEMENT_READY`.

### Provider abstraction

The domain depends on a narrow server-side contract conceptually supporting destination validation, transfer/distribution submission, status retrieval, and provider event verification. Provider adapters translate external status/error models into internal results. Wallet, network, token, fee, transaction, and webhook references are stored separately from settlements.

The simulation provider exercises the same state machine, idempotency, accounting, reconciliation, and audit paths as the real adapter. It is not a UI shortcut.

### Accounting integration

The MVP includes a minimal general-ledger boundary rather than embedding debit/credit logic in the provider adapter. A posting policy maps confirmed settlement facts to a balanced journal entry. Lines reference ledger accounts and exact atomic amounts. A unique posting source prevents duplicates. Later integration with a broader QeSuite ledger can replace the adapter behind the same posting boundary.

Accounting semantics that require business approval—revenue recognition, gross-versus-net presentation, fees, and clearing accounts—remain explicit configuration/decision items and are not invented by infrastructure code.

### Audit and reconciliation

Audit events are append-only and record successful and failed decisions. Sensitive provider payloads are redacted; hashes or selected evidence fields can preserve integrity without storing credentials. Reconciliation compares the internal distribution/provider transaction with provider-confirmed asset, amount, destination, network reference, and status. Mismatches stay visible and require resolution or compensating entries.

### Failures and retries

- Queue consumers classify retryable, ambiguous, and terminal failures.
- Retryable failures use managed delivery retries plus persisted attempt history.
- Terminal/exhausted messages move to a dead-letter path and create an operational exception.
- Ambiguous submissions query by provider reference/idempotency key before retry.
- Scheduled reconciliation finds stuck `SUBMITTING`/`SUBMITTED` records even if callbacks fail.
- State transition compare-and-set/version checks prevent stale updates.
- Manual recovery actions are authorized and audited; they cannot erase failure history.

### Observability and security

Dashboards/queries surface queue lag, outbox age, state age, retry counts, provider latency, approval wait time, unmatched reconciliation, and unbalanced-posting attempts. Logs and traces use correlation IDs. Webhooks require signature verification, freshness/replay checks, deduplication, and rate limiting. Provider credentials are server-side secrets with environment separation and least privilege.

### Advantages

- Strong balance of delivery speed, recoverability, and permanent architecture.
- Managed buffering/backpressure without splitting the application into services.
- Clear failure visibility and replay through outbox/inbox records.
- Keeps all critical local transitions atomic in one database for the MVP.
- Straightforward path from simulation to a real provider adapter.

### Disadvantages

- More infrastructure and test fixtures than Option A.
- Eventual consistency requires excellent UI states and operational tooling.
- Outbox dispatch and inbox deduplication add schema and code.
- Queue ordering must not be assumed; state/version guards are required.

### Assessment

| Dimension                 | Rating                                                       |
| ------------------------- | ------------------------------------------------------------ |
| Implementation complexity | Medium                                                       |
| Hackathon speed           | Very good                                                    |
| Financial safety          | Very good                                                    |
| Long-term maintainability | High                                                         |
| Primary risk              | Incomplete idempotency or poor visibility around async state |

## Option C — Domain-separated Workers with Cloudflare Workflows

### Component/module boundaries and deployment

- React PWA/BFF.
- Separate Workers for business events/rules, approvals/settlements, provider integration, and accounting/audit.
- Cloudflare Workflows coordinates each settlement's durable multi-step lifecycle.
- Queues carry integration events between services.
- D1 databases are separated by domain ownership, with no cross-database transaction.
- Service bindings expose internal contracts; only the edge API is public.

### End-to-end flow

The business-event service commits an event and publishes it. A settlement service matches/snapshots a rule and starts a workflow instance keyed by the settlement. Workflow steps wait for approvals, submit through the provider service, wait/poll for finality, request accounting posting, reconcile, and finish. Each service persists its own records and audit evidence.

### Data ownership and transaction boundaries

Each service owns its database and can transact only within that boundary. Cross-service consistency uses messages, workflow steps, idempotent commands, and compensating actions. The workflow is an orchestrator, not the ledger of record; D1 remains authoritative for business state.

### Rules, approval, provider, and accounting

The logical models match Option B, but service contracts and messages replace in-process calls. Provider credentials are isolated to the provider Worker. Accounting owns journal entries and accepts idempotent posting commands. An audit/read model correlates facts from all services.

### Failures and retries

Workflow steps provide durable retries/waits while service-level idempotency protects every external or financial side effect. Poison messages and permanently failed workflows require operational queues and recovery tooling. Cross-service compensations are explicit because distributed rollback is impossible.

### Observability and security

This option needs end-to-end tracing, workflow-instance correlation, service-level SLOs, contract/version monitoring, and restricted service bindings. Its larger attack and operational surface requires more configuration and deployment discipline.

### Advantages

- Strong provider isolation and independent service ownership.
- Durable long-running orchestration naturally models approval waits and provider finality.
- Services can scale and deploy independently when real load/team boundaries emerge.
- Failures are isolated more clearly than in a single Worker.

### Disadvantages

- Highest implementation, testing, deployment, and observability burden.
- No atomic transaction across event, settlement, accounting, and audit databases.
- More schemas, bindings, contracts, migrations, and failure modes.
- Local development and a polished two-week demo become harder.
- Creates boundaries before actual load or team ownership proves them.

### Assessment

| Dimension                 | Rating                                                                    |
| ------------------------- | ------------------------------------------------------------------------- |
| Implementation complexity | High                                                                      |
| Hackathon speed           | Poor–medium                                                               |
| Financial safety          | Potentially excellent, but only with substantial distributed-systems work |
| Long-term maintainability | High at proven scale; low while the team/system is small                  |
| Primary risk              | Architecture effort displaces the user-facing and financial MVP           |

## Comparison

| Concern              | Option A: D1 jobs       | Option B: outbox + Queues             | Option C: services + Workflows     |
| -------------------- | ----------------------- | ------------------------------------- | ---------------------------------- |
| Deployable units     | 1                       | 1 initially                           | Several                            |
| Authoritative DBs    | 1                       | 1 initially                           | Several                            |
| Async mechanism      | D1 job table + schedule | Transactional outbox + managed queues | Queues + durable workflows         |
| Local atomicity      | Strong                  | Strong                                | Strong only within each service    |
| Retry implementation | Mostly custom           | Managed delivery + domain attempts    | Workflow + queue + domain attempts |
| Approval waits       | DB state                | DB state + event                      | Workflow wait/state                |
| Provider isolation   | Module/adapter          | Module/adapter                        | Separate service                   |
| Demo delivery risk   | Lowest                  | Low–medium                            | Highest                            |
| Growth path          | Replace job runner      | Extract proven hot/bounded areas      | Already distributed                |
| Recommended now      | No                      | **Yes**                               | No                                 |

## Recommendation

Choose **Option B: a modular monolith with D1 transactional outbox and Cloudflare Queues**.

It keeps local financial decisions in one transactional boundary, uses managed asynchronous delivery where external settlement makes it necessary, and avoids prematurely distributing a greenfield system. It is more durable than a home-built job runner and materially faster to deliver than a multi-service Workflow topology.

The recommendation is detailed in `docs/FLOWPAY_RECOMMENDED_ARCHITECTURE.md` and remains proposed until explicitly approved.

## Platform verification note

Before implementation, confirm current binding syntax, limits, retry/dead-letter configuration, transaction semantics, and provider APIs against the official documentation:

- Cloudflare D1: <https://developers.cloudflare.com/d1/>
- Cloudflare Queues: <https://developers.cloudflare.com/queues/>
- Cloudflare Workflows: <https://developers.cloudflare.com/workflows/>
- Cloudflare Workers: <https://developers.cloudflare.com/workers/>
- Circle developer documentation: <https://developers.circle.com/>

No option depends on an undocumented claim of exactly-once queue delivery or a provider-specific atomic multi-beneficiary transfer.
