# FlowPay Recommended Architecture

**Status: Accepted**

**Date:** 2026-09-13

**Recommendation:** Cloudflare-native modular monolith with D1 transactional outbox and Cloudflare Queues

## Decision summary

Build FlowPay as one product and one initial backend deployment with strict internal domain modules. Persist authoritative business and financial state in D1. Commit every publishable domain event to a transactional outbox alongside the state change that produced it, then deliver asynchronous work through Cloudflare Queues. Begin with a simulation settlement provider and add Circle/Arc behind the same provider contract only after its current APIs and test environment are verified.

Do not begin with separate domain services, Durable Objects, or Cloudflare Workflows. Add one only after a measured coordination, duration, scaling, isolation, or team-ownership need makes the added boundary worthwhile.

This recommendation retains the core product flow:

```text
Business Event
  → Rule Evaluation
  → Approval / Control
  → Settlement
  → Provider Confirmation
  → Accounting
  → Reconciliation
  → Audit
```

## Why this option

FlowPay has two competing needs. The hackathon needs a complete, understandable vertical slice quickly; financial execution needs durable state, retries, idempotency, and visible failures. A synchronous-only application is fast but pushes the team toward a home-built job runner. A service/workflow architecture adds distributed consistency and deployment work before the domain is proven.

The recommended design keeps rule, approval, settlement, accounting, and audit changes locally transactional while using queues only across genuine asynchronous boundaries. It is a permanent architecture that can later extract modules without making extraction a prerequisite for the first demo.

## System context

```text
User / approver
      │
      ▼
React PWA ────────────────┐
      │                    │
      ▼                    │
Primary API Worker         │ provider webhook
      │                    ▼
      ├────────────── Provider adapter ───── Circle/Arc test infrastructure
      │                    ▲
      ▼                    │ status query / submission
     D1                    │
      │                    │
      └─ transactional outbox
               │
               ▼
        Cloudflare Queues
               │
               ▼
       Worker queue handlers
               │
               └──────────► D1 state + audit + next outbox event
```

The PWA displays business terminology. Network, token, wallet, and transaction details appear only as secondary settlement evidence.

## Initial deployment topology

- **Web:** React + TypeScript PWA deployed with the Cloudflare application frontend convention selected during bootstrap.
- **API and consumers:** one Cloudflare Worker project with HTTP, queue-consumer, and scheduled handlers sharing application modules.
- **Database:** one D1 database for the hackathon/MVP. All tables carry organisation scope. Table ownership is enforced in code and tests.
- **Messaging:** dedicated logical queues for settlement commands/status work and accounting/reconciliation work; exact queue count should stay minimal during bootstrap.
- **Scheduled recovery:** a scheduled handler dispatches stranded outbox rows, polls provider transactions that lack callbacks, and detects stale states.
- **Secrets:** Cloudflare server-side secret bindings, separated by environment.
- **Observability:** Workers logs/traces plus persisted operational attempt/error records.

An environment may run the simulation adapter without external credentials. The Circle/Arc adapter is enabled only in a dedicated test environment.

## Proposed repository structure

```text
flowpay/
├── apps/
│   ├── web/                         # React PWA and business-facing UI
│   └── api/                         # Worker entrypoints and composition root
├── packages/
│   ├── contracts/                   # versioned API/event schemas
│   ├── domain/                      # exact money and domain primitives
│   ├── organisations/               # organisations, memberships, participants
│   ├── business-events/             # ingestion, event store, outbox
│   ├── rules/                       # rule lifecycle, versions, evaluator
│   ├── approvals/                   # policies, requests, decisions
│   ├── settlements/                 # calculations, lifecycle, orchestration
│   ├── accounting/                  # ledger boundary and journal posting
│   ├── reconciliation/              # provider/internal matching
│   ├── audit/                       # append-only evidence
│   ├── provider-contract/           # SettlementProvider port
│   ├── provider-simulation/         # deterministic demo/test provider
│   ├── provider-circle-arc/         # external adapter; no domain imports outward
│   └── workshop-demo/               # jobs/vehicles and demo event production
├── migrations/                      # ordered, immutable D1 migrations
├── docs/
└── tests/                           # cross-module integration/acceptance tests
```

This is a logical ownership map. The initial implementation may combine very small packages until boundaries contain enough code to justify physical separation. It must not combine workshop-specific types with settlement-domain types.

## Module responsibilities

| Module            | Owns                                                                    | Must not own                              |
| ----------------- | ----------------------------------------------------------------------- | ----------------------------------------- |
| Organisations     | organisations, users/memberships, participants, roles                   | provider credentials or journal entries   |
| Workshop demo     | job/vehicle/customer workflow and generic event production              | entitlement calculation or provider calls |
| Business events   | immutable event envelope, validation, deduplication, outbox             | settlement policy                         |
| Rules             | rule identity, immutable versions, conditions, beneficiary instructions | provider execution                        |
| Approvals         | policies, requests, decisions, satisfaction checks                      | arbitrary settlement state mutation       |
| Settlements       | evaluation evidence, exact calculations, distributions, state machine   | provider-specific SDK types               |
| Provider adapters | destination validation, submission, status translation                  | rule or accounting policy                 |
| Accounting        | ledger accounts, journal entries/lines, posting policies, reversals     | external transfers                        |
| Reconciliation    | matching and discrepancy resolution                                     | rewriting provider or journal history     |
| Audit             | append-only actor/action/evidence records                               | authoritative mutable workflow state      |

Only a module's application service may mutate that module's tables. Cross-module calls use typed commands/results inside the monolith or versioned messages across the queue boundary.

## Core data model

The detailed schema follows approval, but the architecture requires these aggregates or records:

- `Organisation`, `Membership`, `Participant`
- `Customer`, `Job`, `Invoice`, `Payment` in the relevant business/demo module
- `BusinessEvent`
- `SettlementRule`, immutable `SettlementRuleVersion`, conditions and beneficiary instructions
- `ApprovalPolicy`, immutable policy version, `ApprovalRequest`, `ApprovalDecision`
- `Settlement`, `SettlementDistribution`, `SettlementAttempt`
- `SettlementProviderTransaction`, provider-status events
- `LedgerAccount`, `JournalEntry`, `JournalLine`
- `ReconciliationRecord`, reconciliation discrepancies/resolutions
- `AuditEvent`
- `OutboxMessage`, `InboxMessage`

Mutable current-state rows are paired with immutable history/evidence. A settlement points permanently to the exact rule and approval-policy versions applied.

## Exact money model

The recommended domain value is:

```text
Money {
  assetCode: string
  atomicAmount: bigint
  scale: integer
}
```

- `atomicAmount` is never a JavaScript `number`.
- HTTP/message JSON carries the amount as a base-10 integer string plus asset and scale.
- D1 stores the canonical atomic amount as digit text unless implementation tests prove a bounded integer representation remains exact across D1 and the Worker runtime.
- Database `REAL` is forbidden for monetary fields.
- Currency/token metadata defines scale explicitly (for example, fiat minor units or provider token atomic units).
- Arithmetic occurs in shared domain code using `bigint` and checked conversions.
- Value-based approval comparisons use the same exact representation and a policy-defined valuation asset; cross-currency conversion is outside the first MVP unless explicitly approved.

### Percentage calculation

For the MVP, percentage weights are non-negative integer basis points and normally total 10,000. The calculation algorithm:

1. validates all beneficiaries and the rule version;
2. computes each non-remainder share from the original gross atomic amount using integer division and the documented rounding mode;
3. assigns the deterministic residual atomic units to the designated `REMAINDER` beneficiary;
4. if no remainder beneficiary exists, allocates residual units by a documented deterministic order captured in the rule version;
5. rejects the result unless every distribution is non-negative and their sum exactly equals the settlement amount;
6. stores inputs, intermediate numerators/rounding outcomes, residual allocation, and final results as evaluation evidence.

The first acceptance suite must include awkward atomic-unit amounts, zero values, invalid totals, fixed-plus-remainder rules, and duplicate evaluation.

## Business-event contract

All business modules use a versioned envelope:

```text
eventId
eventType
schemaVersion
organisationId
aggregateType / aggregateId
occurredAt / recordedAt
source
correlationId / causationId
payload
```

The event represents a verified business fact, not an instruction to transfer funds. Event ingestion validates organisation scope and schema, inserts the immutable event, and inserts an outbox record atomically. A duplicate `(organisation, source, eventId)` returns the existing result without creating a new effect.

For the flagship demo, `PAYMENT_CONFIRMED` references a payment and job. FlowPay loads authoritative job/payment/participant facts through an internal query boundary; it does not trust a client-submitted “job completed” Boolean as sufficient proof.

## Rules and versioning

`SettlementRule` is the stable identity. Publishing creates an immutable `SettlementRuleVersion` containing:

- trigger event type/schema version;
- effective start/end;
- priority and status;
- typed conditions;
- beneficiary selectors and percentage/fixed/remainder instructions;
- settlement method/provider policy;
- approval policy/version;
- author, publication time, and version number.

Draft versions may be edited. Published/used versions are never edited. Superseding a rule creates a new version. A settlement snapshots the selected version and evaluation evidence.

The MVP expression model is allow-listed and typed—equality, membership, existence, and exact numeric comparisons over named facts. It does not execute arbitrary JavaScript, SQL, or user code. If multiple same-priority rules would produce conflicting settlements, evaluation stops visibly rather than guessing.

## Approval model

Policies support:

- `AUTOMATIC`
- `MANUAL`
- `APPROVAL_REQUIRED` with exact-value bands, required roles, and approval count

An approval request snapshots the policy version and computed settlement amount. Approval decisions are append-only. The service enforces organisation membership, role, distinct approvers, maker-checker/self-approval policy, request state, and threshold requirements. Only policy satisfaction can transition a settlement to `READY`.

## Settlement state machine

Recommended states:

```text
DRAFT
  → PENDING_RULE_EVALUATION
  → PENDING_APPROVAL | READY
READY
  → SUBMITTING
SUBMITTING
  → SUBMITTED | FAILED
SUBMITTED
  → CONFIRMED | FAILED
CONFIRMED
  → REVERSED

DRAFT | PENDING_RULE_EVALUATION | PENDING_APPROVAL | READY
  → CANCELLED
```

Retries do not move a failed/submitted settlement backward by arbitrary update. A retry creates a new attempt under an allowed transition/recovery operation. Partial multi-beneficiary results are represented on each `SettlementDistribution`; the parent cannot be `CONFIRMED` until the defined completion policy is satisfied. A partial external execution is a visible exception requiring recovery—it is never collapsed into a generic failure.

Every transition uses compare-and-set/version checking, validates prerequisites, and appends an audit event in the same local transaction.

## Asynchronous processing and outbox

The outbox is mandatory for state changes that must cause asynchronous work.

1. The application commits domain state and an outbox message atomically.
2. A dispatcher publishes undispatched messages.
3. A queue consumer first claims/deduplicates the message using a unique inbox record.
4. It executes a module command.
5. The command commits state, audit, and any next outbox messages atomically.
6. The queue message is acknowledged only after durable success.

Outbox rows retain dispatch attempt/time/error evidence. A scheduled sweep retries stranded rows. Consumers never rely on delivery order or exactly-once transport.

## Idempotency matrix

| Boundary                | Stable key / constraint                        | Duplicate behavior                                |
| ----------------------- | ---------------------------------------------- | ------------------------------------------------- |
| Event ingestion         | organisation + source + event ID               | Return existing event/result                      |
| Rule application        | source event + rule version                    | Reuse existing evaluation/settlement              |
| Queue consumer          | consumer name + message ID                     | Acknowledge completed work or resume safe attempt |
| Approval decision       | request + actor (and decision identity)        | No duplicate approval count                       |
| Settlement creation     | evaluation identity                            | Reuse existing settlement                         |
| Distribution submission | settlement/distribution stable idempotency key | Query/reuse provider operation                    |
| Provider callback       | provider + provider event ID                   | Ignore already-applied callback                   |
| Accounting posting      | posting purpose + source type/source ID        | Return existing journal entry                     |
| Reversal                | original posting/settlement + reversal purpose | Return existing reversal                          |

Idempotency keys are persisted before external calls and reused across network retries. A timeout with unknown outcome is reconciled by key/reference before another submission is allowed.

## Settlement provider boundary

The provider contract is server-side and domain-neutral. Its conceptual capabilities are:

- validate or normalize a destination;
- create/retrieve wallet information only if the chosen provider model requires it;
- optionally quote relevant fees;
- submit one transfer/distribution with a caller-supplied stable idempotency key;
- retrieve status by provider reference or idempotency key;
- verify and normalize provider callbacks;
- return network/transaction evidence.

The contract returns internal result types such as accepted, confirmed, rejected, retryable failure, or outcome unknown. Provider-specific statuses, SDK models, and credentials do not cross into rule or accounting modules.

The simulation provider persists deterministic fake provider transactions and can be configured to confirm, fail, delay, duplicate callbacks, and return ambiguous timeouts. This ensures the demo and tests exercise production-shaped recovery paths.

The Circle/Arc adapter is an external integration, not application infrastructure. Its exact wallet model, API endpoints, asset/network identifiers, webhook scheme, fee behavior, and distribution capabilities must be verified against current official documentation immediately before implementation.

## Arc / USDC Technical Assessment

**Assessment date:** 2026-09-14

**Decision status:** Arc + USDC is a leading settlement-layer candidate, not an accepted technology decision.

The decisions are deliberately separate:

- **Product decision — accepted:** FlowPay should support programmable stablecoin settlement as part of the business workflow.
- **Technology decision — open:** The architecture review must still select the Circle product, chain/environment, wallet and custody model, EOA/SCA choice, individual-versus-batched transfer flow, confirmation mechanism, and whether any custom contract is justified.

The accepted FlowPay architecture remains provider-neutral. Rules, approvals, accounting, reconciliation, and audit are authoritative QeSuite capabilities; Arc, Circle Wallets, Circle Mint, Gateway, CCTP, or a smart contract may implement a settlement port but may not redefine that business workflow.

### Capabilities verified

| Area                                  | Current official-documentation finding                                                                                                                                                                                                                                                                                              | FlowPay implication                                                                                                                                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arc availability and status           | Arc is a public testnet with chain ID `5042002`, public HTTPS/WSS RPC endpoints, and a testnet explorer. On 2026-09-14, a read-only call to the documented RPC returned the expected chain ID and a current block. Circle has announced a 2026-09-16 public-mainnet launch, so this status is unusually time-sensitive.             | The hackathon can develop against Arc Testnet now. Network/mainnet status must be rechecked at implementation and demo-readiness gates.                                                                                       |
| USDC availability                     | USDC is native on Arc Testnet and its documented ERC-20 address is `0x3600000000000000000000000000000000000000`. Testnet USDC has no financial value and is not backed by dollars.                                                                                                                                                  | Suitable for an explicitly labelled test settlement demo; never represent testnet activity as movement of real funds. Resolve token identifiers from current official configuration rather than hardcoding remembered values. |
| EVM compatibility                     | Arc uses an EVM execution layer targeting the Osaka hard fork and supports standard Solidity tooling. Arc documents runtime differences that must be reviewed before coding.                                                                                                                                                        | Existing EVM libraries and contracts are usable, but “EVM-compatible” does not mean behavior is identical in every detail.                                                                                                    |
| Fees and precision                    | Arc uses USDC as the native gas token with EIP-1559 plus EWMA fee smoothing. The current testnet minimum base-fee floor is 20 Gwei. Native gas accounting uses 18 decimals, while the USDC ERC-20 interface uses 6 decimals over the same underlying balance.                                                                       | The adapter needs separate explicit precision metadata for native gas values and ERC-20 transfer values. It must estimate fees and preserve enough USDC for gas where an EOA pays fees.                                       |
| Finality                              | Arc documents deterministic sub-second finality with no additional confirmation window after block commitment.                                                                                                                                                                                                                      | This reduces chain-finality latency, but FlowPay must still wait for the selected provider's terminal status and persist its evidence rather than treating an API acceptance response as confirmation.                        |
| Circle Wallets support                | Circle Wallets lists `ARC-TESTNET` as testnet-only and supports developer-controlled and user-controlled EOAs/SCAs plus modular smart-contract accounts. Its normal Wallets endpoints are available for Arc rather than only signing support.                                                                                       | Circle can manage wallet creation, signing, broadcasting, indexing, balances, transfers, and contract calls without FlowPay running a blockchain node.                                                                        |
| Developer-controlled wallet APIs/SDKs | Circle provides REST APIs plus official Node.js/TypeScript and Python SDKs. The current quickstart creates a wallet set and an Arc Testnet EOA or SCA.                                                                                                                                                                              | Developer-controlled wallets fit backend-initiated ERP settlement, subject to accepting the custody and entity-secret responsibilities. The SDK shape must be re-read immediately before implementation.                      |
| Transfer initiation                   | The Wallets transfer API/SDK sends USDC from a developer-controlled wallet to any address on the same chain. Requests accept a stable UUIDv4 idempotency key; the API can estimate/select fees.                                                                                                                                     | A settlement distribution can map to one provider transaction. The FlowPay distribution key remains the durable source of truth and is reused on retry.                                                                       |
| Status and confirmation               | A create-transfer response is asynchronous (for example, `INITIATED`). Circle exposes Get/List Transaction and states including `INITIATED`, `QUEUED`, `SENT`, `CONFIRMED`, `COMPLETE`, `FAILED`, `STUCK`, and `CANCELLED`; Circle Wallets marks a transaction `COMPLETE` after its chain confirmation threshold.                   | Store Circle transaction ID and transaction hash separately. Map provider states to FlowPay states; do not collapse `STUCK`, `FAILED`, or unknown outcomes.                                                                   |
| Notifications                         | Circle recommends Wallets webhooks as the primary status mechanism; Get/List Transaction polling is the recovery/fallback path. Webhook delivery may be duplicated, and Circle exposes signature/key headers and a public-key endpoint for verification.                                                                            | Use verified, deduplicated webhooks for low-latency updates plus a scheduled polling reconciler for missed callbacks and stale submissions.                                                                                   |
| Circle idempotency                    | Mutating Wallets requests require a UUIDv4 `idempotencyKey`; reuse is treated as the same request and returns the original/existing result. SDKs generate request ciphertext/idempotency details in their documented high-level flows.                                                                                              | Circle's facility complements rather than replaces FlowPay's database uniqueness, outbox/inbox deduplication, and unknown-outcome reconciliation. Persist the key before any call.                                            |
| Test funding                          | The official Circle faucet currently includes Arc Testnet USDC. The current faucet UI states a per-address, per-blockchain rate limit and currently offers 20 test USDC per hour; CCTP is another way to move test USDC from a supported testnet.                                                                                   | Pre-fund demo wallets well before rehearsals, reserve gas, record faucet funding as test setup, and keep the simulation provider available if faucet/testnet services are unavailable.                                        |
| Smart contracts                       | Arc supports Solidity deployment and calls. Circle Contracts supports Arc Testnet deployment, interaction, templates, and event monitoring. Arc also documents an ERC-8183 job/escrow workflow.                                                                                                                                     | Escrow or onchain enforcement is technically possible, but it is not required to make FlowPay programmable. Any contract introduces a separate security, upgrade, audit, and reconciliation surface.                          |
| Multi-party tools                     | Circle Wallets SCAs can atomically batch user operations through `executeBatch`. Circle Contracts has an audited Airdrop template for multi-recipient ERC-20 distribution (Circle recommends no more than 500 recipients per call). Gateway and CCTP address crosschain liquidity/transport rather than FlowPay entitlement policy. | Atomic SCA batching is a credible later option for an all-or-nothing split. Airdrop is a bulk-distribution primitive, not a settlement/accounting engine. Neither should own commercial rules or approvals.                   |
| Simpler Circle path                   | Circle Mint supports Arc only in its sandbox environment at this assessment date and can transfer from a funded business account to administrator-allowlisted recipient addresses. Circle's production availability, account eligibility, compliance, and recipient workflow differ from developer-controlled Wallets.              | Circle Mint sandbox is worth a spike as a simpler treasury-style demo path, but it is not automatically simpler operationally and must not be assumed available for production Arc.                                           |

### Implementation options

| Option                                                            | Shape                                                                                                       | Advantages                                                                                                                                              | Constraints / fit                                                                                                                                                                                                           |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Circle Wallets, developer-controlled EOA, individual transfers | FlowPay computes the split and submits one idempotent USDC transfer per distribution.                       | Smallest transparent integration; direct mapping between a beneficiary distribution, provider transaction, journal evidence, and reconciliation record. | Multiple onchain transactions mean partial completion is possible. The source wallet must retain USDC for both settlement and gas. FlowPay owns approval controls and recovery.                                             |
| B. Circle Wallets, developer-controlled SCA, atomic batch         | FlowPay encodes multiple USDC transfers into one SCA `executeBatch` call; Gas Station may sponsor fees.     | One atomic chain transaction; lower partial-settlement risk; potentially simpler beneficiary confirmation.                                              | More encoding/account-abstraction complexity, deployment/gas policy dependencies, and a coarser transaction-to-distribution evidence mapping. Must verify Arc-specific limits and Wallets behavior in a spike.              |
| C. Circle Mint sandbox transfer APIs                              | A funded Circle business account sends to approved/allowlisted beneficiary addresses.                       | Familiar treasury/payout model; Circle manages the account-side transfer flow; no application wallet-set design.                                        | Arc is documented as sandbox-only today. Requires Mint access, funding, administrator-approved recipients, and applicable compliance data. The production path could differ during/after the hackathon.                     |
| D. Custom or template smart contract                              | A contract escrows funds or performs multi-recipient distribution; FlowPay authorizes the contract call.    | Can provide atomic distribution or genuine onchain escrow where the commercial requirement demands it.                                                  | Highest security and audit burden. Contract immutability/upgrades, access control, approvals, pause/recovery, rounding, and reconciliation all require design. Circle's Airdrop template is not tailored to ERP settlement. |
| E. Raw self-managed EVM transactions                              | FlowPay or separate key infrastructure signs and broadcasts native/ERC-20 transfers over Arc RPC.           | Maximum protocol control and minimal reliance on a wallet API.                                                                                          | Adds private-key/HSM/MPC, nonce, broadcast, indexing, fee, and operational responsibility. It is not justified for the MVP while Circle Wallets provides supported Arc infrastructure.                                      |
| F. Gateway/CCTP-assisted flow                                     | Gateway supplies unified crosschain balance or CCTP transports USDC between chains, followed by settlement. | Useful if source liquidity and beneficiary destination chains differ.                                                                                   | Crosschain movement is not an MVP business requirement. It adds domains, attestations, contracts, fees, and reconciliation stages without replacing the split engine.                                                       |

### Suitability and recommended use

Arc + USDC is suitable for the hackathon because its testnet is operational, USDC is both the settlement asset and gas token, Circle Wallets provides first-class Arc Testnet APIs, and the EVM environment leaves an incremental path to atomic batching or escrow. It also aligns with the proposal's stablecoin-settlement story while keeping blockchain details behind FlowPay's provider boundary.

The hackathon testnet implementation selected in ADR-016 is **application-managed settlement logic with Circle developer-controlled wallets and individual Arc Testnet USDC transfers**. This keeps commercial calculation, approval, accounting, reconciliation, and audit in QeSuite and makes every beneficiary payment independently traceable. It is a narrow testnet adapter decision, not authorization for live funds or a production custody decision.

The spike must compare that path against:

1. a developer-controlled SCA atomic batch for the three-way distribution; and
2. Circle Mint sandbox transfers if the team already has the required account access and can pre-approve recipients.

Adopt SCA batching only if the review makes atomic all-or-nothing distribution a first-MVP requirement and the added test/security burden is acceptable. Do not deploy a custom settlement or escrow contract for the MVP unless an actual business requirement cannot be met by Wallets transfers or SCA batching. Do not add Gateway or CCTP unless crosschain funding or destination support becomes a demonstrated requirement.

The simulation provider remains mandatory. It proves the permanent FlowPay workflow and supplies a deterministic demo fallback; Arc demonstrates one real provider implementation rather than becoming the domain architecture.

### Security considerations

- Developer-controlled wallets are a custodial application model: FlowPay's backend initiates and authorizes transactions on users' behalf. QeSuite must explicitly accept that custody, compliance, and operational responsibility before production use.
- Circle Wallets uses MPC for developer-controlled wallets, but QeSuite controls authorization through a 32-byte entity secret that Circle says it does not store. Protect it with server-side secret storage, separate environments, access logging, rotation/recovery procedures, and no browser or log exposure.
- Direct REST calls require a newly encrypted, unique entity-secret ciphertext for each request. Prefer an official SDK if it correctly manages that lifecycle in the Worker runtime; verify runtime compatibility and storage behavior during the spike.
- API keys are bearer credentials for privileged operations. Use separate test/live keys, least-privilege operational access, rotation, and Cloudflare secret bindings. Never place them in source, ordinary variables, client code, error messages, or audit payloads.
- Circle's Wallets API reference was rechecked on 2026-09-14 and documents `X-Circle-Key-Id`, `X-Circle-Signature`, the authenticated `GET /v2/notifications/publicKey/{id}` lookup, and `ECDSA_SHA_256`. The retrieved official pages did not specify the exact signed-byte construction or signature encoding. Do not guess those details: keep callbacks disabled until Circle's current webhook-verification guide or an official SDK supplies that contract. Polling remains the safe confirmation path meanwhile. Once verified, also deduplicate notification IDs, tolerate reordering, cap body size, and make handlers replay-safe.
- Provider capability is not business authorization. A technically valid transfer must never bypass FlowPay approval thresholds, maker-checker rules, destination controls, or settlement state transitions.
- Validate destination chain/address and asset identifiers immediately before submission. Separate rule approval from beneficiary-destination change approval, and audit both.
- Treat provider acceptance, chain broadcast, chain confirmation, Circle `COMPLETE`, accounting posting, and reconciliation as distinct facts.

### Constraints and testnet approach

- At this assessment date, Arc is still a public testnet and Circle Mint labels Arc support sandbox-only. Testnet balances have no value, service/API behavior may change, and production support must not be inferred.
- Circle has announced a mainnet launch two days after this assessment and before the hackathon. That increases—not decreases—the need to recheck official documentation, supported-product matrices, contract addresses, API schemas, rate limits, and network status at implementation time.
- Arc currently uses a permissioned validator cohort even though developer access is permissionless. Availability and governance assumptions must be revisited before production deployment.
- The 18-decimal native gas / 6-decimal ERC-20 dual interface is a material correctness hazard. Provider tests must cover exact conversions, fee reservation, balance interpretation, and transfer-event indexing.
- Individual multi-party transfers can partially complete. The data model therefore keeps per-distribution state and supports visible recovery even if an atomic option is later selected.
- A transaction may be accepted by Circle but not final. Webhook plus scheduled polling is required, and an ambiguous timeout blocks blind resubmission.
- Faucet limits, account rate limits, wallet transaction queues, webhook duplication, contract-call limits, and testnet instability must be exercised during rehearsal.

Testnet execution sequence:

1. Use simulation for the full business acceptance flow and failure/retry demonstrations.
2. In an isolated Arc environment, create dedicated test wallet(s), fund them from the official faucet, and record wallet/asset/network configuration without committing credentials.
3. Submit one low-value individual USDC transfer using a FlowPay-persisted idempotency key.
4. Confirm through Get Transaction polling; store Circle ID, Arc transaction hash, fee, timestamps, and terminal status. Add webhooks only after the exact signed-message contract is officially documented or an official verifier is available.
5. Replay the same event, queue message, and API retry to prove no duplicate transfer or accounting entry. Add duplicate-notification acceptance coverage when signed callbacks are enabled.
6. Run the three-beneficiary scenario and force/observe partial and ambiguous outcomes with simulation even if the Arc happy path succeeds.
7. Spike SCA batching and Circle Mint sandbox separately; record the architecture decision before choosing one for the flagship demo.

### Official sources consulted

Primary sources checked on 2026-09-14:

- [Arc network overview](https://docs.arc.io/arc-chain), [connect to Arc Testnet](https://docs.arc.io/arc/references/connect-to-arc), [gas and fees](https://docs.arc.io/arc/references/gas-and-fees), [EVM differences](https://docs.arc.io/arc/references/evm-differences), and [deterministic finality](https://docs.arc.io/arc/concepts/deterministic-finality)
- [Circle introduction to Arc](https://www.circle.com/blog/introducing-arc-an-open-layer-1-blockchain-purpose-built-for-stablecoin-finance), [Arc Public Testnet announcement](https://www.circle.com/pressroom/circle-launches-arc-public-testnet), and [announced September 2026 mainnet launch](https://www.circle.com/pressroom/circle-announces-founding-validator-cohort-and-major-integrations-for-arc-ahead-of-september-16-mainnet-launch)
- [Circle Wallets supported blockchains](https://developers.circle.com/wallets/supported-blockchains), [developer-controlled wallets](https://developers.circle.com/wallets/dev-controlled), [Arc Testnet wallet quickstart](https://developers.circle.com/wallets/dev-controlled/create-your-first-wallet), and [send tokens across wallets](https://developers.circle.com/wallets/dev-controlled/transfer-tokens-across-wallets)
- [Wallets transfer API](https://developers.circle.com/api-reference/wallets/developer-controlled-wallets/create-developer-transaction-transfer), [get transaction API](https://developers.circle.com/api-reference/wallets/developer-controlled-wallets/get-transaction), [transaction limits/status guidance](https://developers.circle.com/wallets/transaction-limits-and-optimizations), and [blockchain confirmations](https://developers.circle.com/wallets/blockchain-confirmations)
- [Circle API keys](https://developers.circle.com/wallets/create-api-key), [wallet signing/authorization](https://developers.circle.com/wallets/signing-and-authorization-models), [key management](https://developers.circle.com/wallets/key-management), and [webhook signature public key](https://developers.circle.com/api-reference/wallets/common/get-notification-signature)
- [Official Circle faucet](https://faucet.circle.com), [USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses), [USDC](https://www.circle.com/usdc), and [Circle transparency](https://www.circle.com/transparency)
- [Circle Wallets 2025 release notes](https://developers.circle.com/release-notes/w3s-2025) and [stablecoin 2025 release notes](https://developers.circle.com/release-notes/stablecoins-2025)
- [Circle Wallets batch operations](https://developers.circle.com/wallets/batch-operations), [Circle Contracts supported blockchains](https://developers.circle.com/contracts/supported-blockchains), [Airdrop template](https://developers.circle.com/contracts/airdrop), and [Arc ERC-8183 job/escrow tutorial](https://docs.arc.io/arc/tutorials/create-your-first-erc-8183-job)
- [Circle Mint supported chains/currencies](https://developers.circle.com/circle-mint/supported-chains-and-currencies), [Circle Mint onchain transfers](https://developers.circle.com/circle-mint/howtos/transfer-on-chain), [Circle Gateway](https://developers.circle.com/gateway), and [CCTP supported chains/domains](https://developers.circle.com/cctp/concepts/supported-chains-and-domains)

**Implementation gate:** re-open the official pages and current OpenAPI/SDK references immediately before writing any Circle/Arc adapter. Do not code from this assessment's remembered field names, statuses, addresses, limits, or launch assumptions.

### Adapter spike re-verification

On 2026-09-14, immediately before creating the provider spike, the Arc network page, Wallets supported-chain matrix, Wallets and stablecoin release notes, developer-controlled transfer and Get Transaction API references, address validation, confirmation/queue guidance, entity-secret documentation, and notification public-key endpoint were re-opened. The spike therefore uses the current documented `ARC-TESTNET` identifier, USDC scale 6, UUIDv4 idempotency requirement, transfer/address/status REST paths, and `COMPLETE` as the only successful terminal Wallets state.

`packages/provider-circle-wallets` now retains the low-level REST spike for contract evidence and provides the production-oriented `CircleWalletsSdkProvider` using the pinned official `@circle-fin/developer-controlled-wallets` SDK. FlowPay supplies its already-persisted UUIDv4 idempotency key; the SDK produces fresh entity-secret ciphertext for sensitive requests. Exact transfer/status/error mappings are mocked and tested, and Wrangler successfully bundles the SDK into the Worker with `nodejs_compat`.

The Worker registers the adapter only when `FLOWPAY_PROVIDER=circle-wallets` and all required server-side bindings are present. Missing or partial configuration fails closed and leaves durable work pending. Scheduled Get Transaction polling is the current confirmation path. The official notification-key reference currently exposes the key/signature headers and ECDSA algorithm but not enough signed-byte/encoding detail to implement a verifier without guessing, so inbound Circle callbacks remain disabled. A live-wallet test, fee evidence, SCA batch comparison, Mint-access check, and production custody approval remain outstanding.

## Accounting architecture

Accounting is an independent domain boundary. Settlement code emits an idempotent posting request containing business facts; an accounting posting policy produces a balanced journal entry.

Every journal entry has:

- organisation, date, currency/asset and status;
- source event, settlement, distribution, and provider references where relevant;
- immutable debit/credit lines in exact atomic units;
- posting-policy version;
- audit/correlation metadata.

Draft entries may be validated. Posted entries are immutable. Corrections create linked reversing or adjusting entries. The database and domain tests reject unbalanced postings.

The exact chart of accounts and recognition policy are business decisions still requiring approval. Infrastructure must not silently decide whether FlowPay acts as principal or agent, whether workshop receipts are gross revenue, or when beneficiary payables are recognized.

## Reconciliation

Reconciliation is explicit, not inferred from a successful HTTP response. It compares:

- expected distribution asset, amount, destination, and provider policy;
- submitted provider transaction and attempt;
- provider-confirmed final state and network reference;
- corresponding accounting posting(s).

Records have matched, mismatched, pending, and exception/resolved outcomes. Resolution records an authorized actor, reason, evidence, and any compensating settlement or journal entry. A scheduled job finds submitted transactions without timely confirmation and confirmed transactions without accounting/reconciliation.

## Audit strategy

`AuditEvent` is append-only and captures:

- organisation, actor/service identity, action, timestamp;
- target aggregate and prior/new state where applicable;
- event and correlation/causation IDs;
- rule and policy versions;
- condition results and calculation evidence references;
- approval decision references;
- provider attempt/status evidence with sensitive fields redacted;
- journal/reconciliation references;
- retry, error classification, and recovery action.

Audit data supports human-readable settlement timelines. It is not a substitute for module-owned state. The first release should prevent update/delete through application services; stronger tamper-evidence/export retention can be designed after the core append-only model is working.

## Failure and recovery policy

Failures are classified as:

- **validation/business rejection:** terminal until inputs/rules change; no provider call;
- **authorization/approval rejection:** visible and terminal for that request;
- **retryable technical failure:** retry with bounded exponential backoff and persisted attempts;
- **ambiguous external outcome:** freeze resubmission, query by idempotency/reference, escalate if unresolved;
- **terminal provider failure:** mark failed with normalized and redacted reason;
- **partial distribution:** exception state with per-distribution truth and an authorized recovery plan;
- **accounting/reconciliation failure:** provider truth remains recorded; posting/reconciliation retries independently and stays visible.

Dead-lettered work creates an operational exception. Manual retry, cancel, reverse, or resolve actions require explicit permission and append audit evidence.

## Security boundaries

- Authentication is required for every non-health application endpoint.
- Server-side organisation membership and role checks protect every command/query.
- Approvers and operators receive least privilege; maker-checker constraints are policy-driven.
- Provider credentials, signing material, entity secrets, and webhook secrets never reach the browser or logs.
- Provider webhooks use current provider signature verification, timestamp/replay controls, body-size limits, rate limiting, and stable-event deduplication.
- Destination changes and rule activation are high-risk actions requiring elevated authorization and audit; optional separate approval should be supported.
- Data queries are organisation-scoped by construction and covered by cross-tenant tests.
- Error responses do not expose secrets, stack traces, or sensitive provider payloads.
- Test, preview, and production resources and credentials are isolated.

The authentication implementation itself remains an explicit pre-bootstrap choice. An adapter boundary should avoid coupling financial domain code to the chosen identity provider.

## Observability and operational controls

Minimum structured telemetry:

- request/message/correlation/settlement IDs;
- event ingestion and rule-match counts;
- settlement count and age by state;
- approval queue age;
- outbox age and dispatch failures;
- queue attempts/dead letters;
- provider latency/outcomes and ambiguous submissions;
- accounting-posting failures/unbalanced attempts;
- reconciliation age and mismatches.

Logs redact wallet secrets, credentials, raw webhook secrets/signatures, and unnecessary personal data. Operational UI/API views must make failures and pending states visible; logs alone are insufficient for financial operations.

## MVP vertical slice

The first coherent slice demonstrates:

1. set up an organisation and authorized demo users/roles;
2. create participants and destinations;
3. create a workshop job and confirmed customer payment;
4. publish a versioned 25% / 70% / 5% rule;
5. ingest `PAYMENT_CONFIRMED` idempotently and verify completed-job conditions;
6. persist evaluation evidence and exact $250 / $700 / $50 distributions;
7. enforce the selected approval policy;
8. execute through the simulation provider using the production state machine;
9. post an approved balanced accounting treatment;
10. reconcile provider and internal records;
11. show a complete settlement detail/audit timeline;
12. replay duplicate events/messages/callbacks without duplicate settlement, transfer, approval, or journal effects.

Only after this path passes financial tests should the Circle/Arc adapter replace simulation in a test environment.

## Required validation strategy

The bootstrap milestone must select test/lint/typecheck/format commands. Before the MVP is accepted, tests must cover:

- exact money parsing/serialization and rejection of floats;
- percentage, fixed, and remainder calculations and awkward rounding;
- sum-of-distributions invariant;
- rule effective dates, priority/conflicts, and immutable versions;
- every allowed and forbidden settlement transition;
- all approval threshold boundaries and role/maker-checker rules;
- event, message, provider, webhook, and posting idempotency;
- outbox recovery after publish failure;
- retryable, terminal, ambiguous, duplicate, delayed, and partial provider outcomes;
- balanced journal entries, unique posting, reversal behavior;
- reconciliation matches/mismatches and recovery;
- cross-organisation authorization denial;
- redaction of sensitive error/audit/log fields;
- end-to-end workshop acceptance flow.

Integration tests must use actual migrations and the chosen Cloudflare local runtime where behavior depends on D1 or Queues. Narrow unit tests alone do not prove financial idempotency.

## Consequences

### Easier

- Completing a polished end-to-end hackathon demonstration.
- Keeping core financial transitions atomic in one database.
- Inspecting and replaying async work without hiding failure.
- Adding provider adapters without changing business modules.
- Extracting a module later because ownership and contracts already exist.

### Harder

- The application must model eventual consistency explicitly in UI and tests.
- Outbox/inbox code and operational views are required from the beginning.
- A single D1 database requires deliberate organisation partitioning/capacity planning as the product grows.
- Module boundaries rely on code structure and architecture tests rather than deployment isolation.

## Deferred extraction triggers

Reconsider separate Workers or Workflows only when evidence shows one of:

- provider operations routinely span long waits or multi-step compensation that is materially simpler as a durable workflow;
- settlement/accounting workloads need independent scaling or availability;
- provider credentials require a stronger deployment/security boundary;
- D1 capacity/locality requires per-organisation or domain partitioning;
- separate teams own and release modules independently;
- a serialized per-resource concurrency problem cannot be solved safely with D1 constraints/versioning.

An extraction requires an ADR covering ownership, contracts, consistency, migration, observability, and rollback.

## Unresolved design and business questions

These do not invalidate the architecture recommendation, but they must be resolved at the named gate:

1. **Before bootstrap:** package manager, frontend deployment convention, schema/validation library, query layer, testing stack, and authentication provider.
2. **Before schema approval:** organisation/participant identity model, supported MVP assets and scales, D1 amount encoding, destination lifecycle, and data retention.
3. **Before rule implementation:** fact vocabulary, rule conflict behavior, rounding/residual policy, fixed-plus-percentage constraints, time-zone/effective-date semantics, and who may publish rules.
4. **Before approval implementation:** exact threshold bands, roles, distinct-approver rules, self-approval policy, rejection/cancellation semantics, and whether destination/rule changes require approval.
5. **Before accounting implementation:** chart of accounts, principal-versus-agent treatment, revenue/payable recognition timing, clearing-account flow, provider fee treatment, and reversal policy.
6. **Before Circle/Arc implementation:** provider account/wallet model, supported test network and USDC identifier, custody/security responsibilities, webhook verification, idempotency/search behavior, fees, rate limits, and transaction finality definition.
7. **Before demo readiness:** whether settlement is automatic or manager-approved, the exact demo currency display, and the permitted simulation/testnet disclosure.

## Decisions requiring explicit approval

Approval of this proposal means approving all of the following architecture decisions—not the unresolved business policies above:

1. FlowPay is a greenfield QeSuite repository and not based on another local QeSuite, restaurant, or POS codebase.
2. Use a Cloudflare-native modular monolith for the first production-shaped implementation.
3. Use one primary Worker deployment and one D1 database initially, with strict internal module/table ownership.
4. Use a D1 transactional outbox plus Cloudflare Queues for external/financial asynchronous work.
5. Do not introduce separate domain Workers, Durable Objects, or Workflows in the MVP without a new approved ADR.
6. Represent money as exact atomic integers with explicit scale; never use binary floating-point for financial data or calculation.
7. Use immutable rule/policy versions, explicit approval enforcement, validated settlement state transitions, and append-only audit history.
8. Isolate providers behind `SettlementProvider`; implement simulation first and Circle/Arc as an adapter after current API verification.
9. Keep accounting as an independent double-entry boundary with immutable posted entries and explicit reversals.
10. Keep workshop-specific concepts in a demo/business module, outside the reusable FlowPay core.

These decisions were explicitly accepted by the project owner on 2026-09-13. Material changes require a superseding architecture decision record.
