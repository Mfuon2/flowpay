# QeSuite FlowPay Product Charter

**Status:** Governing product definition

**Tagline:** Business happens. Money follows.

## Product definition

QeSuite FlowPay is an event-driven programmable settlement and accounting engine embedded within QeSuite. It connects verified operational events to configurable commercial rules, approvals and controls, multi-party settlement, accounting entries, reconciliation, and a complete audit trail.

It is not a crypto payment application, trading interface, DeFi product, or garage-specific system. Stablecoin and blockchain infrastructure are optional provider-layer implementations. Normal users work with jobs, invoices, payments, participants, settlements, accounts, approvals, reconciliation, and audit evidence.

The governing flow is:

```text
Business Event
  → Rule and conditions
  → Approval and control
  → Settlement
  → Accounting
  → Reconciliation
  → Audit
```

The concise product innovation is **Event → Rule → Settlement → Accounting**.

## Platform and module boundary

QeSuite is the platform. FlowPay is a permanent QeSuite capability composed of rules, approvals, escrow, settlements, wallets/provider configuration, reconciliation, and audit views. This greenfield repository is the implementation home selected for QeSuite FlowPay; it does not change the product into a separate wallet or crypto startup.

Business modules own operational concepts and emit versioned facts. FlowPay consumes those facts through generic contracts. Business modules never call blockchain providers or calculate settlement entitlements directly.

## Flagship demonstration

The first adapter and hackathon story is Metro Auto Works:

- a completed and paid $1,000 job;
- workshop entitlement: 25%;
- mechanic entitlement: 70%;
- referrer entitlement: 5%;
- exact results: $250, $700, and $50;
- required controls before settlement;
- accounting, reconciliation, and a complete explanation of what happened.

Workshop entities and terminology remain outside FlowPay core. The same rule engine must support contractors, construction milestones, salons, consultants, suppliers, commissions, platforms, and procurement without business-type branches.

## MVP scope

The hackathon MVP targets only the business surface needed to prove the complete flow:

- core business: organisation, customers, participants, services, jobs, quotes, invoices, and payments;
- FlowPay: events, settlement rules, preview, approvals, settlements, provider/wallet evidence, optional escrow spike, and transaction history;
- accounting: accounts, journals, receivables/payables needed by the demo, and reconciliation;
- governance: events, evaluated rules, conditions, decisions, approvals, transactions, and accounting audit evidence;
- experience: dashboard, settlement detail/timeline, resilient states, and a focused demo dataset.

Inventory, HR, payroll, broad CRM, POS, and full procurement suites are outside the hackathon MVP.

## Product and technology decisions

**Product decision:** FlowPay supports programmable stablecoin settlement as one settlement method.

**Technology decision:** The network, Circle/Arc components, wallet custody model, individual-versus-batch transfer model, contract/escrow model, confirmation flow, and production provider remain subject to the architecture review and implementation-time documentation checks.

Provider technology serves the business lifecycle; it does not define it.

## Safety and financial behavior

- An event never bypasses its rule's manual, approval-required, automatic, or threshold control.
- Money uses exact atomic units with explicit precision and deterministic rounding.
- Duplicate inputs never produce duplicate settlements, transfers, journals, or reconciliation effects.
- Posted financial history and decision evidence are append-only; corrections use reversals or adjustments.
- Failed, pending, ambiguous, and unreconciled operations stay visible.
- Provider transaction evidence is subordinate to the business explanation.

## Experience direction

The product is mobile-first, compact, responsive, and styled as professional ERP software. Blockchain terms are hidden unless a user opens technical settlement evidence. The flagship settlement detail must explain the trigger, matched rule/version, condition results, calculation, approvals, execution, accounting, reconciliation, retries/failures, and provider reference in one readable timeline.

## Build principle

Build the domain model, database invariants, event architecture, financial controls, and provider abstraction before individual screens. Deliver a thin complete business flow before expanding breadth. Hackathon work must remain a durable QeSuite capability.
