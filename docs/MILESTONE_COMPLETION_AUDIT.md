# FlowPay Milestone Completion Audit

**Audit date:** 2026-09-15

**Authoritative plan:** `docs/ROADMAP.md`

**Result:** The implementation is complete through the local hackathon MVP and the isolated Cloudflare demo infrastructure is deployed. The full roadmap is not yet complete because Cloudflare Access enrollment, credentialed Arc Testnet evidence, and the final rehearsal gates remain external dependencies.

## Evidence standard

A milestone is marked complete here only when its implementation, durable schema/evidence, relevant tests, and build checks exist in the current repository. Documentation or a plausible design alone is not treated as implementation proof. External behavior is not treated as verified without provider/platform evidence.

## Milestone audit

| Milestone                           | Result                  | Authoritative evidence                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Discovery and architecture      | Proven complete         | `FLOWPAY_ARCHITECTURE_OPTIONS.md`, `FLOWPAY_RECOMMENDED_ARCHITECTURE.md`, `ARCHITECTURE.md`, ADR-001 through ADR-016                                                                                                                                                                                                                      |
| 1 — Provider-neutral domain         | Proven complete         | `packages/domain`, provider contract/simulation packages, migrations 0001–0002, pure domain/provider tests                                                                                                                                                                                                                                |
| 2 — Rules and approvals             | Proven complete for MVP | Versioned rule/policy authoring and evaluation services, migrations 0002–0004 and 0017, maker-checker/approval/configuration tests and authenticated API/PWA controls                                                                                                                                                                     |
| 3 — Idempotent orchestration        | Proven complete for MVP | Transactional outbox/inbox, Queue consumer/quarantine, durable work/attempts, status polling, unknown-outcome recovery, migrations 0005–0006 and 0015–0016, execution/observation/replay tests                                                                                                                                            |
| 4 — Accounting and reconciliation   | Proven complete for MVP | Exact double-entry package/services, versioned posting policies, immutable posting/reversal/resolution migrations, business/settlement accounting and reconciliation tests                                                                                                                                                                |
| 5 — Circle/Arc decision and adapter | Partially proven        | Official docs were rechecked; ADR-016 selects the hackathon-only adapter; official SDK adapter tests and Worker bundling pass. No Circle credentials/wallet mappings exist, so no live low-value transfer, fee record, or account-eligibility comparison is proven                                                                        |
| 6 — Workshop acceptance vertical    | Proven complete locally | Metro seed; generic business services; isolated workshop extension; $1,000 → $250/$700/$50 end-to-end acceptance; duplicate/failure tests; exact Services/Quotes authoring and quote-approval event adapter                                                                                                                               |
| 7 — Business PWA                    | Proven complete for MVP | Responsive installable React PWA; business, rules, approvals, settlement, escrow, accounting, reconciliation, audit, operations, Services, and Quotes views; production PWA build passes                                                                                                                                                  |
| 8 — Demo hardening                  | Partially proven        | Tenant/security tests, persisted Operations view, recovery UI, CI workflow, runbooks, deterministic fallback, fresh two-pass seed verification, dependency audit, Worker startup profile, isolated D1/Queues, remote migration/seed verification, and Worker deployment are proven. Access enrollment and actual rehearsal remain pending |

## Product-flow audit

| Requirement                  | Evidence                                                                                                                       | Result                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Business event               | Immutable versioned events, payment/invoice/quote/job/milestone adapters and deduplication                                     | Proven                                     |
| Conditions / commercial rule | Versioned rules, typed facts/operators, deterministic priority/effective-time selection, evaluation evidence                   | Proven                                     |
| Approval                     | Manual/automatic/threshold policies, maker-checker activation, role/count/distinct-approver enforcement                        | Proven                                     |
| Settlement                   | Exact distributions, provider abstraction, durable attempts, simulation and Circle adapter                                     | Proven locally; live Arc execution pending |
| Accounting                   | Versioned event/obligation/cash policies, exact balanced journals, immutable postings and reversals                            | Proven                                     |
| Reconciliation               | Per-distribution provider/journal checks, mismatch visibility and append-only resolution                                       | Proven                                     |
| Audit                        | Correlation/causation, conditions, decisions, transitions, attempts, provider references, journals and reconciliation timeline | Proven                                     |

## Financial-control audit

- No monetary runtime path uses JavaScript `number` for amounts; canonical atomic strings and `bigint` are used for arithmetic.
- Distribution tests cover percentage, fixed, remainder, awkward rounding, huge values, and exact total preservation.
- Quote tests cover multi-line and fractional quantities, values above `Number.MAX_SAFE_INTEGER`, and exact line/total derivation.
- D1 triggers protect business/financial transitions and append-only or immutable records.
- Persisted attempt UUIDv4 values are created before provider calls and reused as Circle idempotency/request IDs.
- Unknown external outcomes freeze resubmission until an authorized evidence-bearing recovery decision.
- Provider confirmation, accounting posting, reconciliation, and escrow release remain separate states.
- Cross-organisation and role tests cover authenticated reads and financial mutations, including the Operations projection.

## Arc / Circle requirement audit

The required technical assessment exists under the exact `## Arc / USDC Technical Assessment` heading in `FLOWPAY_RECOMMENDED_ARCHITECTURE.md`. It records current testnet/network status, USDC availability, EVM behavior, gas, Wallets support, SDK/API capability, transfer initiation, transaction status, polling/webhook analysis, idempotency, faucet, contracts, multi-party tools, security, restrictions, implementation options, suitability, and official sources.

Implementation evidence proves the current official SDK request shape through a pinned dependency and mocks, plus successful Worker bundling. It does **not** prove Circle account entitlement, wallet balances, real provider acceptance, an Arc transaction hash, or fees. Those remain deliberately unclaimed.

## Remaining completion gates

1. Create a Cloudflare Access application for the deployment, configure its exact `TEAM_DOMAIN` and `POLICY_AUD`, and provision separate D1 application identities/memberships from verified Access subjects. The application API currently fails closed without a valid Access JWT.
2. Configure Circle test API key/entity secret through Cloudflare secrets, plus the current Arc Testnet USDC token UUID, source wallet UUID, and beneficiary addresses. The environment audit found all Circle settings unset.
3. Recheck the current official Circle/Arc documentation and network status on the execution day.
4. Execute one low-value individual Arc Testnet USDC transfer; poll it to Circle `COMPLETE`; retain Circle transaction ID, Arc hash, fee, timestamps, and reconciliation evidence.
5. Confirm actual Circle account eligibility for the SCA batch and Circle Mint sandbox alternatives, or explicitly record why they are unavailable and retain ADR-016.
6. Replay the live event/request path and prove that no duplicate provider transfer or journal is created.
7. Run the deployment and three-minute demo rehearsal checklists with named reviewers and capture results.

Until all seven gates have evidence, the active “complete all milestones” goal must remain incomplete.

## Cloudflare deployment evidence

- Deployment date: 2026-09-15
- Worker/PWA: `https://flowpay-api.leemfo.workers.dev`
- Worker version: `2a34a185-a1bc-4392-8df9-d2732eeba953`
- D1: isolated `flowpay` database in WEUR; all migrations `0001`–`0024` applied
- Queues: isolated `flowpay-events` and `flowpay-events-dlq`
- Provider mode: deterministic `simulation` / `CONFIRMED`; no Circle secrets configured
- Remote seed: first import succeeded; second import wrote zero application rows
- Remote quote proof: `quote-nissan-juke` is `APPROVED`, total `100000` at USD scale 2, with one line and two append-only transitions
- Smoke tests: `/` = 200, `/api/health` = 200 with D1 healthy, `/api/v1/dashboard` = 401 when an organisation is supplied without an Access JWT
- Deployment bundle: 632.66 KiB (121.12 KiB gzip); Cloudflare reported 10 ms startup
- Local startup profile: 11.4 ms active startup after the final provider/configuration build
- Source/CI: initial `main` commit `96bda25`; GitHub Actions run `34942077470` passed the full validation gate in 1m01s
