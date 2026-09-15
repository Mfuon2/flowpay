# Current QeSuite Architecture

**Discovery date:** 2026-09-13

> Historical discovery snapshot. The repository has since been implemented; see `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, and `docs/DECISIONS.md` for current state.

**Repository:** `git@github.com:Mfuon2/flowpay.git`

**Finding:** FlowPay is a greenfield QeSuite capability. No application code or previously selected software architecture exists in this repository.

## Executive summary

The repository currently contains a proposal-first handoff pack only. It defines the FlowPay product concept, workshop demonstration, financial constraints, and the process for selecting an architecture. It does not contain a frontend, backend, database, migrations, authentication, accounting, payment integration, tests, deployment configuration, or package/workspace structure.

This means there are no existing QeSuite implementation conventions or modules to reuse in this repository. The architecture options must therefore be evaluated as greenfield designs against the agreed product constraints and the preferred Cloudflare direction in the project instructions.

No restaurant, POS, or other local project was used as an architectural source. Those are separate projects and are outside this repository's scope.

## Repository state inspected

The repository was initialized locally on 2026-09-13 with branch `main` and the following remote:

```text
origin  git@github.com:Mfuon2/flowpay.git
```

The tracked-candidate content at discovery time consists of:

```text
.env.example.flowpay
AGENTS.md
README_FOR_HANDOFF.txt
START_HERE.md
codex-prompts/00_DISCOVER_AND_DESIGN_ARCHITECTURE.md
codex-prompts/01_AFTER_ARCHITECTURE_APPROVAL.md
docs/ARCHITECTURE_DECISION_TEMPLATE.md
docs/DEMO_SCENARIO.md
docs/HACKATHON_PROPOSAL.md
docs/OPEN_ARCHITECTURE_QUESTIONS.md
docs/PRODUCT_REQUIREMENTS.md
manifest.json
```

The local `.DS_Store` file is not a project artifact and should be ignored before the first commit.

## Discovery matrix

| Requested discovery item     | Current evidence                        | Status / implication                                                   |
| ---------------------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| Overall structure            | Documentation and prompts only          | No application structure selected                                      |
| Frontend framework           | None installed                          | React/PWA is a preference, not an existing implementation              |
| Backend/API                  | None                                    | Cloudflare Workers is preferred by project guidance but not configured |
| Package/workspace structure  | No `package.json` or workspace manifest | Must be proposed and approved                                          |
| Database                     | None                                    | D1 is a preferred direction, not an existing dependency                |
| ORM/query layer              | None                                    | Must be selected during detailed design                                |
| Migrations                   | None                                    | A versioned migration convention is required before schema work        |
| Authentication               | None                                    | Required before financial actions are exposed                          |
| Authorization/roles          | None                                    | Approval roles and segregation of duties must be designed              |
| Accounting                   | Product requirements only               | No ledger, chart of accounts, posting service, or integration exists   |
| Payments                     | Product requirements only               | No payment or settlement provider implementation exists                |
| Money/currency types         | Constraint only: exact arithmetic       | Representation remains an architecture decision                        |
| Workflow/state abstractions  | Conceptual settlement lifecycle only    | State transitions must be designed and enforced                        |
| Queue/events/background jobs | None                                    | No event transport or async runtime has been selected                  |
| Hosting/deployment           | None                                    | Cloudflare is preferred; topology remains proposed                     |
| Testing                      | None                                    | Framework and commands must be selected during bootstrap               |
| Lint/typecheck/format        | None                                    | Toolchain must be selected during bootstrap                            |
| Reusable components          | Proposal documents and terminology      | No reusable software components exist yet                              |

## Reusable project assets

Although there is no reusable code, the handoff pack supplies durable inputs:

- product boundary: a programmable settlement capability, not a wallet or garage application;
- canonical business flow: Business Event → Rule → Approval → Settlement → Accounting → Reconciliation → Audit;
- flagship workshop scenario and expected $1,000 distribution;
- financial invariants covering exact money, deterministic rounding, idempotency, approvals, traceability, and immutable history;
- provider-neutral intent with a simulation adapter and eventual Circle/Arc test integration;
- architecture questions and an approval gate before implementation;
- an environment-variable template that contains no credentials.

## Existing constraints that architecture must honor

1. The workshop belongs in a demonstration/business module. `Mechanic`, `Vehicle`, and workshop-specific rules must not enter the reusable settlement core.
2. `SettlementRule` is a first-class, versioned domain concept.
3. Business modules emit or record provider-neutral business events. They must not invoke blockchain/provider SDKs directly.
4. A duplicate business event, queue delivery, webhook, retry, or provider callback must not create duplicate financial execution.
5. Money must use an exact representation with explicit currency/token precision and deterministic rounding.
6. Approval policies must be enforced before execution and must support amount thresholds.
7. Settlement states must change through validated, auditable transitions.
8. Accounting entries must trace to the event, rule version, settlement, and provider transaction where applicable.
9. Posted financial history and audit records must be append-only or corrected with explicit reversals/adjustments.
10. Provider-specific details and secrets must remain behind an adapter boundary and server-side configuration.
11. The solution should remain useful after the hackathon and should not introduce distributed-system complexity without a concrete need.

## Gaps FlowPay must fill

Because this is greenfield, every runtime capability is new. The minimum coherent system needs:

- a mobile-first React/PWA application shell;
- an authenticated, authorized API;
- organisation and participant records;
- workshop demo records outside the core domain;
- a business-event ingestion contract;
- a versioned rule and condition model;
- deterministic entitlement calculation;
- approval policy and approval requests;
- settlement orchestration and validated state transitions;
- a simulation provider first and a provider adapter contract for Circle/Arc;
- journal entry and ledger-account primitives sufficient for double-entry demonstration;
- reconciliation records;
- append-only audit events;
- idempotency records/unique constraints at every side-effect boundary;
- tests for calculations, rounding, state transitions, retries, and accounting balance;
- deployment, migrations, observability, and operational recovery documentation.

## Architecture discovery conclusion

There is no current QeSuite software architecture to map FlowPay onto. The honest baseline is greenfield. The next decision is therefore which greenfield topology best balances hackathon speed with permanent financial correctness. The options and recommendation are documented in:

- `docs/FLOWPAY_ARCHITECTURE_OPTIONS.md`
- `docs/FLOWPAY_RECOMMENDED_ARCHITECTURE.md`
