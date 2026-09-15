# QeSuite FlowPay — Flagship Demo Scenario

## Demo business

An automotive workshop.

## Participants

- Customer
- Workshop
- Mechanic
- Referrer

## Job

Example:

```text
Vehicle: Nissan Juke
Job value: $1,000
Status: Completed
```

## Commercial agreement

```text
Workshop     25%
Mechanic     70%
Referrer      5%
```

## Trigger

Customer payment is confirmed.

## Expected FlowPay behavior

FlowPay should be able to demonstrate:

```text
PAYMENT_CONFIRMED
        ↓
Check job status
        ↓
Check applicable agreement/rule
        ↓
Check participants
        ↓
Calculate entitlements
        ↓
Apply approval policy
        ↓
Execute or simulate settlement
        ↓
Record accounting consequence
        ↓
Reconcile
        ↓
Display audit trail
```

## Expected result

```text
Customer payment     $1,000

Workshop               $250
Mechanic               $700
Referrer                 $50
```

## Demo narrative

The key message is:

> The workshop isn't the product. The rule engine is.

The workshop proves the idea in a context anyone can understand.

After the demo, show that the same mechanism could handle:

- suppliers;
- contractor milestones;
- consulting splits;
- commissions;
- construction payments;
- marketplace distributions.

---

## What the judge should see

The final polished demo should ideally make visible:

- the job;
- the payment;
- the commercial rule;
- the conditions;
- the split calculation;
- approval state;
- settlement state;
- transaction reference;
- accounting reference;
- audit timeline.

The exact screens and architecture are still open design questions.
