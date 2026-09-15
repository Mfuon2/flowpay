# QeSuite FlowPay Architecture Decision Log

Durable decisions are appended here. A changed decision is superseded by a new ADR rather than silently rewritten.

## ADR-001 — Greenfield FlowPay repository

**Status:** Accepted, 2026-09-13

FlowPay is implemented in this dedicated QeSuite repository. No restaurant/POS codebase is a source or dependency. There was no existing application/accounting implementation to reuse at discovery time.

## ADR-002 — Cloudflare-native modular monolith

**Status:** Accepted, 2026-09-13

Begin with one Worker deployment and one D1 database, separated into strict internal business modules. Do not introduce microservices, Durable Objects, or Workflows until a measured extraction trigger exists.

## ADR-003 — Transactional outbox and at-least-once queues

**Status:** Accepted, 2026-09-13

State and publishable messages are committed together in D1. Cloudflare Queues carry asynchronous work; inbox/domain uniqueness makes duplicate delivery safe.

## ADR-004 — Exact money

**Status:** Accepted, 2026-09-13

Use non-negative integer atomic units with explicit asset and scale. Runtime arithmetic uses `bigint`; API and D1 serialization uses canonical integer strings. No binary floating point or D1 `REAL` monetary values.

## ADR-005 — Immutable financial meaning

**Status:** Accepted, 2026-09-13

Applied rule/policy versions, approval decisions, business events, audit events, and posted accounting history are append-only. Corrections create new versions, attempts, reversals, or adjustments.

## ADR-006 — Provider abstraction and simulation first

**Status:** Accepted, 2026-09-13

Settlement providers sit behind `SettlementProvider`. The first adapter is deterministic simulation so the complete business and recovery workflow does not rely on an external testnet.

## ADR-007 — Arc + USDC technology choice remains open

**Status:** Open candidate, reviewed 2026-09-13

Programmable stablecoin settlement is a product decision. Arc + USDC is a leading provider-layer candidate, but Circle product, custody model, EOA/SCA, individual/batch transfer, and contract choices require a documented spike and architecture review. Recheck official Circle/Arc documentation at implementation time.

## ADR-008 — Workshop is a demonstration boundary

**Status:** Accepted, 2026-09-13

Workshop/customer/job/vehicle behavior belongs to a demo/business module. FlowPay core consumes generic, versioned business events and generic participant/beneficiary identities.

## ADR-009 — Independent accounting boundary

**Status:** Accepted architecture; accounting policy open, 2026-09-13

Accounting is a first-class module with exact double-entry journals, idempotent posting, traceability, and reversals. Principal/agent treatment, recognition timing, account mapping, and fees require separate business approval.

## ADR-010 — Current Cloudflare toolchain

**Status:** Accepted for foundation, 2026-09-14

Use TypeScript, npm workspaces, Wrangler 4, D1 migrations, Vitest 4 with the current Cloudflare Vitest plugin, ESLint, and Prettier. Versions are pinned for reproducible hackathon work and should be deliberately upgraded.

## ADR-011 — QeSuite platform and FlowPay product charter

**Status:** Accepted, 2026-09-14

QeSuite is the platform and FlowPay is an embedded, reusable settlement and accounting capability. The dedicated greenfield repository is its implementation home, not a decision to create a standalone crypto wallet/startup. The workshop is the first business adapter and demonstration only. `docs/PRODUCT_CHARTER.md` governs product scope, language, build order, and the separation between programmable-stablecoin product intent and the still-open provider technology choice.

## ADR-012 — Cloudflare Access identity boundary

**Status:** Accepted for the hackathon deployment, 2026-09-14

Protect the PWA/API with a Cloudflare Access self-hosted application and also validate the `Cf-Access-Jwt-Assertion` signature, issuer, and application audience inside the Worker. Access proves identity; D1 application users, organisation memberships, and roles grant application authority. Client-supplied tenant, actor, role, and permission claims are never trusted. This follows the current [Cloudflare Access JWT validation guidance](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), rechecked on 2026-09-14.

## ADR-013 — Same-origin PWA and API Worker deployment

**Status:** Accepted for the modular monolith, 2026-09-14

Build the React PWA as static assets attached to the API Worker. Cloudflare serves the PWA asset-first with SPA fallback, while `/api/*` runs the Worker first. This preserves one same-origin security boundary, avoids CORS and duplicated deployment configuration, and remains consistent with ADR-002. The configuration follows the current [Cloudflare Workers static assets guidance](https://developers.cloudflare.com/workers/static-assets/), rechecked on 2026-09-14.

## ADR-014 — Escrow is a controlled business workflow before a custody choice

**Status:** Accepted for the provider-neutral MVP, 2026-09-14

Model escrow as an exact, immutable funding allocation and milestone-release workflow in the FlowPay domain. Authorized milestone verification emits a generic business event into the same versioned rule, approval, provider, accounting, reconciliation, and audit pipeline used by other settlements. A milestone release is recorded only after the linked settlement is confirmed. This decision does not claim that D1 holds funds and does not select Circle wallets, Arc smart contracts, or another custody mechanism; that technology/custody decision remains open under ADR-007.

## ADR-015 — Principal accounting presentation for the workshop demo

**Status:** Accepted for the hackathon demo; production accounting review required, 2026-09-14

For Metro Auto Works, demonstrate the workshop as principal in the customer repair transaction. Invoice issuance posts debit Customer Receivable / credit Service Revenue. Confirmed payment posts debit Settlement Digital Cash / credit Customer Receivable. Explicit contractor and referral mappings post their expense/payable obligations; the workshop's own share creates no external obligation. Confirmed settlement clears external payables and moves the workshop share from settlement cash to operating cash through beneficiary-specific debit mapping. These mappings live in versioned accounting policy data and the demo seed, not participant-type or workshop-specific application branches. Fees, tax, contract-specific recognition, and real production use require qualified accounting review.

## ADR-016 — Hackathon Arc Testnet adapter uses Circle Wallets EOA transfers and polling

**Status:** Accepted for hackathon testnet implementation; production decision open, 2026-09-14

Implement the selected hackathon provider adapter with Circle Developer-Controlled Wallets, individual EOA USDC transfers on `ARC-TESTNET`, and authenticated Get Transaction polling. FlowPay persists one UUIDv4 attempt/idempotency identity before every external call; the pinned official Circle SDK supplies a fresh entity-secret ciphertext and is compatible with the Worker dry-run bundle. Each beneficiary remains a separately observable and recoverable distribution.

This does not change the product decision or make Circle/Arc part of the domain architecture. Simulation remains the deterministic fallback. Application rules, approvals, escrow workflow, accounting, reconciliation, and audit remain authoritative. SCA batching, Circle Mint, custom smart-contract escrow, mainnet custody, compliance, and production provider selection remain separate review decisions.

Circle callbacks are not enabled. The official material rechecked on 2026-09-14 identifies signature/key headers, the notification public-key endpoint, and `ECDSA_SHA_256`, but does not establish the exact signed-byte construction and signature encoding needed for a safe implementation. Scheduled polling is therefore the accepted MVP confirmation mechanism; a future callback ADR requires current official verification documentation or an official verifier.
