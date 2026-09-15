# QeSuite FlowPay — Product Requirements

## Objective

Demonstrate that verified business events can drive programmable financial settlement inside an ERP.

---

## Required business capabilities

The hackathon MVP should ultimately demonstrate:

1. a business event occurs;
2. FlowPay identifies the applicable commercial rule;
3. required conditions are checked;
4. beneficiary entitlements are calculated;
5. any required approval is enforced;
6. settlement is executed or simulated;
7. accounting impact is recorded;
8. settlement is reconciled;
9. the full decision trail is inspectable.

---

## Core concepts

These concepts are important at product level, but their technical representation is not yet decided:

- Business Event
- Settlement Rule
- Conditions
- Beneficiaries
- Entitlements
- Approval Policy
- Settlement
- Accounting Posting
- Reconciliation
- Audit Trail

---

## Workshop MVP

The workshop demo should support a flow similar to:

- create or load a customer job;
- identify mechanic/workshop/referrer;
- record the commercial split;
- mark the job completed;
- confirm customer payment;
- calculate split;
- approve if required;
- settle or simulate settlement;
- display accounting effect;
- display audit trail.

Example:

```text
Gross: $1,000

Workshop: 25% = $250
Mechanic: 70% = $700
Referrer: 5% = $50
```

---

## Financial correctness requirements

Regardless of architecture:

- money must not use unsafe floating-point arithmetic;
- calculations must be deterministic;
- duplicate processing must not create duplicate payment;
- the applied rule must be identifiable;
- approvals must be enforceable;
- execution failures must remain visible;
- accounting links must be traceable;
- financial history must be reviewable.

---

## Out of scope for the first MVP

Unless needed by the existing QeSuite architecture:

- full payroll;
- full procurement suite;
- full inventory redesign;
- advanced treasury;
- tax engine;
- multi-chain routing;
- production custody;
- complex compliance orchestration;
- generalized workflow programming language;
- every future vertical.

---

## UX requirement

The product should feel like QeSuite/business software.

Blockchain/provider details should be secondary.

A judge should understand the product without needing crypto knowledge.
