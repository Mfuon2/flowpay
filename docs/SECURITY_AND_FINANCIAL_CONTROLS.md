# QeSuite FlowPay Security and Financial Controls

## Trust boundaries

- Browser/PWA: untrusted input; no provider or signing secrets.
- Worker/API: authenticates, authorizes, validates, and orchestrates.
- D1: authoritative application/financial state with constrained and append-only records.
- Queues: at-least-once untrusted delivery order; messages contain no secrets.
- Settlement provider: external system whose acceptance and finality are separate facts.
- Provider webhook: public endpoint requiring current signature verification and replay protection.

## Required controls

- Server-side organisation membership and role enforcement on every command/query.
- Least privilege and maker-checker separation for high-value settlement, rule activation, and destination changes.
- Immutable rule/policy versions and append-only decisions/audit/provider inputs.
- Stable persisted idempotency keys at event, queue, provider, callback, posting, and reversal boundaries.
- Exact monetary representation and deterministic rounding.
- Explicit validated settlement actions; no arbitrary status PATCH.
- Destination/asset/network validation immediately before submission.
- Visible partial, failed, stuck, and unknown outcomes; blind retry is prohibited.
- Double-entry validation and reversal/adjustment rather than edits to posted history.
- Tenant-isolation tests and organisation-scoped query construction.

Approval application services accept organisation, actor, and role information only as trusted internal authorization context. HTTP mutation routes must derive these values from the authenticated principal and server-side organisation membership; client-supplied role or tenant claims are never authoritative. Decisions use stable identities, request-version concurrency checks, maker-checker rules, distinct approvers, and append-only evidence. Rejections require a recorded reason.

Cloudflare Access protects the deployed application, and the Worker independently validates the assertion header against the team JWKS, expected issuer, audience, expiry, and RS256 signature. Token subject and normalized email must both match an active application user. Organisation selection is accepted only with an active membership and server-side roles. API v1 fails closed when Access configuration is absent.

Manual release additionally requires the internal `FLOWPAY_SETTLEMENT_RELEASE` permission. Authorization is checked before replay details are returned, and concurrent identical commands resolve to one auditable state transition.

An unknown provider submission is never retried merely because a lookup is missing or times out. Scheduled polling leases each pending provider record and backs off durably. When an interrupted call produced no provider transaction identity, retry requires an authorized finance operator to record the reason and a provider verification reference proving that no transfer was created. The recovery decision is append-only and the original attempt remains in history.

Escrow authoring and lifecycle commands are organisation-scoped and finance-controlled. The arrangement amount and precision are inherited from its linked payment, the milestone schedule must allocate that amount exactly, and both become immutable. Funding cannot be confirmed until the payment is confirmed. Milestone verification requires an operational/manager control role, records structured evidence, and emits a generic business event; the applicable settlement rule still enforces its approval policy before any provider submission. Release state advances only from a linked settlement whose normalized state is `CONFIRMED`. Disputes require an explicit reason and block new milestone verification while open.

Only owner/admin/finance roles may resolve reconciliation exceptions or reverse posted journals. Both commands require a reason and external evidence reference and are stable-idempotent. Reconciliation resolution preserves the original mismatch evidence in place and appends a separate immutable resolution. Journal correction creates one balanced inverse entry linked to the unchanged original; database constraints prohibit a second reversal of the same journal.

Business accounting uses active, versioned, effective-dated policies selected deterministically at event time. Account IDs never come from browser event payloads. Invoice, receipt, obligation, and cash-movement services verify tenant, active account, asset, and scale consistency before atomic posting. Beneficiary obligation mappings are explicit and duplicate mappings are invalid, preventing participant type labels from silently deciding accounting treatment.

## Secrets and signing

Never commit or log API keys, private keys, entity secrets, ciphertext inputs, seed phrases, webhook secrets/signatures, or recovery material. Use Cloudflare secret bindings separated by local/test/preview/production environment. Restrict operational access and define rotation, compromise, and recovery procedures before external funds are used.

For the hackathon Arc Testnet adapter, QeSuite accepts a custodial backend authorization role. The entity secret remains QeSuite's responsibility even though Circle uses MPC. The pinned official SDK generates fresh ciphertext for sensitive requests; API key and entity secret are Cloudflare secret bindings and are never browser-visible. Signed callbacks remain disabled until the exact current verification contract is official and implementable; scheduled authenticated status polling is the safe confirmation path.

## Audit and privacy

Audit evidence records identifiers, decisions, normalized states, redacted errors, hashes/references, and actor/correlation provenance. It must not become a secret dump or duplicate unnecessary personal data. Retention/export/tamper-evidence policy is required before production.

## Operational controls

- Alerts/views for stale approvals, outbox backlog, dead letters, stuck/unknown provider transactions, posting failures, and reconciliation mismatches.
- Bounded retry with jitter and attempt evidence.
- Explicit operator commands for retry, cancel, reverse, and resolve, each authorized and audited.
- Separate test and live provider accounts/wallets/resources.
- Simulation provider retained for deterministic failure testing and demo fallback.

Queue messages are schema-validated and contain no credentials. Permanent message failures are preserved in an append-only quarantine table; transient handler failures use bounded platform retries and the configured dead-letter queue.

## Production gates

Before moving real value, approve custody/legal/compliance posture, authentication and role model, destination lifecycle, transaction and approval limits, chart of accounts, reconciliation ownership, provider incident procedures, secret recovery, data retention, and tested rollback/reversal runbooks.
