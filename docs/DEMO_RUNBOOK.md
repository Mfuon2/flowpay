# FlowPay Hackathon Demo Runbook

## Disclosure

Say this before showing any provider evidence:

> This demonstration uses simulated settlement or Arc Testnet USDC. Testnet USDC has no monetary value. QeSuite FlowPay is the business rule, approval, accounting, reconciliation, and audit system; Circle/Arc is one replaceable settlement adapter.

Never imply that a simulated or testnet transaction moved real customer funds.

## Three-minute story

### 0:00–0:25 — Business problem

Open **Overview**. Explain: business software knows work is complete and a payment arrived, yet people still calculate shares, initiate payouts, post accounts, and reconcile manually.

### 0:25–0:55 — Verified business event

Open the Metro Auto Works job and payment. Show the completed Nissan Juke job and the confirmed $1,000 customer receipt. Emphasize that the business module emitted an event; it did not call a blockchain provider.

### 0:55–1:25 — Commercial rule and control

Open **Rules** and the active Workshop Partner Split:

- Workshop: 25% / $250
- Mechanic: 70% / $700
- Referrer: 5% / $50

Show the approval policy. Explain that provider capability never bypasses business authorization.

### 1:25–2:30 — Settlement evidence

Open the flagship settlement detail. Walk down one screen:

1. trigger and immutable rule version;
2. passed conditions and exact distribution;
3. approval decision;
4. provider transaction state/reference;
5. balanced journal entries;
6. reconciliation result;
7. append-only audit timeline.

Use business terms. Mention Arc only in the secondary execution evidence.

### 2:30–3:00 — Resilience and platform value

Open **Operations**. Show that failed, pending, mismatched, quarantined, and unknown work cannot disappear. State that duplicate events do not create duplicate transfers or journals. Close with:

> Work happens. Conditions are verified. Money moves. Accounts update. Everything is auditable.

## Rehearsal matrix

Run and record each scenario before the demo freeze:

| Scenario                         | Expected evidence                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Flagship success                 | One settlement; 250/700/50; approval; all transfers confirmed; balanced journals; matched reconciliation |
| Duplicate payment/event delivery | Existing result returned; no second settlement, transfer, or journal                                     |
| Retryable provider failure       | Persisted attempt and bounded retry schedule; no hidden failure                                          |
| Terminal provider failure        | Failed distribution/work visible in Operations and settlement audit                                      |
| Ambiguous submission             | `OUTCOME_UNKNOWN`; no blind retry; finance recovery requires reason and provider evidence                |
| Reconciliation mismatch          | Original mismatch remains; authorized resolution appends evidence                                        |
| Accounting correction            | Original posted journal remains; one linked exact reversal is posted                                     |
| Testnet unavailable              | Switch to deterministic simulation; disclose it explicitly; full business flow remains demonstrable      |

## Pre-demo checklist

- Run `npm run validate` and retain the output.
- Apply and seed a clean isolated demo D1 database.
- Confirm Cloudflare Access and organisation memberships using a non-owner test account.
- Confirm **Operations** has no unexplained critical items.
- Pre-open the flagship records; never depend on faucet funding during the presentation.
- If using Arc Testnet, verify current Circle/Arc documentation, network status, wallet balances, source/destination mappings, and one low-value rehearsal transaction that day.
- Keep simulation configured and rehearsed as the fallback.
- Do not display environment settings, API keys, entity secrets, raw notification signatures, or wallet recovery material.
