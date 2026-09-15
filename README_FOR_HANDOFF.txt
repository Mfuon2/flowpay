QeSuite FlowPay — Implementation Handoff

This is the dedicated greenfield implementation repository for the QeSuite
FlowPay capability. It does not use or depend on the restaurant/POS codebase.

Start with START_HERE.md and docs/PRODUCT_CHARTER.md. The accepted architecture
is in docs/FLOWPAY_RECOMMENDED_ARCHITECTURE.md and durable decisions are in
docs/DECISIONS.md.

The provider-neutral business, rule, approval, settlement, accounting,
reconciliation, audit, API, and PWA foundations are implemented. Circle Wallets
individual EOA transfers plus polling are selected only for the hackathon Arc
Testnet adapter under ADR-016. Production custody/provider choices remain open.

Local verification:

  npm install
  npm run db:migrate:local
  npm run db:seed:local
  npm run validate

The idempotent Metro Auto Works seed leaves PAY-00292 pending so its confirmation
can initiate the real event-driven workflow. Application access still requires a
valid Cloudflare Access identity with an active D1 organisation membership.
