# QeSuite FlowPay — Open Architecture Questions

These questions are intentionally unresolved.

Codex should answer them only after inspecting the real QeSuite repository.

---

## 1. Where should FlowPay live?

Possible options may include:

- module inside existing backend;
- bounded domain/package;
- separate service;
- hybrid approach.

Which best fits QeSuite today?

---

## 2. How should business events reach FlowPay?

Possibilities may include:

- direct application service calls;
- domain events;
- database outbox;
- queue;
- existing event infrastructure.

Do not introduce an event bus unless the repository and requirements justify it.

---

## 3. What needs to be synchronous vs asynchronous?

For example:

- rule evaluation;
- approvals;
- provider submission;
- transaction confirmation;
- accounting posting;
- reconciliation.

Which steps benefit from async processing?

---

## 4. How should settlement rules be represented?

Possibilities:

- normalized relational tables;
- versioned JSON configuration;
- hybrid model;
- existing QeSuite workflow/rules abstraction.

How should rules be versioned?

---

## 5. How should money be represented?

Inspect existing QeSuite conventions.

Questions:

- integer minor units?
- decimal type?
- bigint?
- string serialization?
- multi-currency support already present?

---

## 6. How should idempotency work?

Where should uniqueness be enforced?

How do we prevent:

- duplicate event processing;
- duplicate settlement creation;
- duplicate provider submission;
- duplicate webhook handling;
- duplicate accounting posting?

---

## 7. How should approvals integrate?

Does QeSuite already have:

- roles?
- permissions?
- approval workflows?
- maker-checker patterns?

Reuse existing patterns if possible.

---

## 8. How should accounting integrate?

Does QeSuite already have:

- chart of accounts?
- journal entries?
- receivables?
- payables?
- reconciliation?

FlowPay should integrate rather than build a second ledger.

---

## 9. How should provider infrastructure be isolated?

What is the cleanest abstraction for:

- simulation provider;
- stablecoin/testnet provider;
- future payment rails?

---

## 10. How should provider status updates arrive?

Possibilities:

- webhook;
- polling;
- scheduled job;
- queue;
- provider-specific event stream.

Which fits the deployment environment?

---

## 11. What deployment model fits QeSuite?

Questions:

- current hosting?
- Cloudflare Workers?
- Pages?
- D1?
- other database?
- queues?
- Durable Objects?
- background processing limitations?

Do not assume any of these until inspected.

---

## 12. What should the MVP architecture optimize for?

Balance:

- speed for hackathon;
- correctness;
- maintainability;
- observability;
- ability to remain part of QeSuite after the hackathon.

---

## Required architecture output

After repository discovery, Codex should propose **2–3 concrete architecture options**.

Each should include:

- component/module boundaries;
- request/event flow;
- persistence;
- settlement execution;
- accounting integration;
- audit;
- failure/retry strategy;
- pros;
- cons;
- implementation complexity;
- hackathon suitability;
- long-term suitability.

Then Codex should recommend one.

No major implementation should begin before this architecture decision is reviewed.
