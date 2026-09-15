# FlowPay Operations and Recovery Runbook

## Operating rule

Provider truth, FlowPay state, accounting state, and reconciliation state are distinct. Never force them to agree by editing history. Diagnose the failed boundary, record evidence, and use a named recovery, reversal, or resolution command.

## First response

1. Open **Operations** for the affected organisation.
2. Identify the settlement and correlation ID from the linked evidence screen.
3. Check state transitions, attempts, provider references, journal entries, and reconciliation checks.
4. Check structured Worker logs by correlation/settlement ID. Do not paste secrets or raw provider authorization payloads into tickets.
5. Classify the incident before acting.

| Condition                                      | Safe response                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Event awaiting dispatch                        | Let scheduled outbox recovery retry; investigate repeated `last_error` before manual intervention                                                                        |
| Queue message quarantined                      | Correct the producer/schema; replay only through a reviewed, idempotent mechanism                                                                                        |
| Approval pending                               | Obtain the required eligible, distinct approvers; never mutate the settlement state                                                                                      |
| Retryable pre-acceptance error                 | Allow bounded work retry using the persisted attempt policy                                                                                                              |
| Provider transaction pending                   | Poll by provider transaction ID; do not resubmit                                                                                                                         |
| Submission outcome unknown without provider ID | Freeze. Search Circle using the persisted UUIDv4 idempotency/request evidence. Retry only after finance records provider non-submission evidence in the recovery control |
| Terminal provider failure                      | Preserve the attempt; decide whether a new authorized settlement/recovery is commercially valid                                                                          |
| Accounting work failed                         | Fix the policy/configuration cause, then run the idempotent posting worker; never invent provider confirmation                                                           |
| Reconciliation mismatch                        | Investigate each recorded check; resolve with reason/evidence or post a compensating/reversing entry                                                                     |
| Incorrect posted journal                       | Post the exact linked reversal; never edit/delete the original                                                                                                           |

## Ambiguous Circle submission

This is the highest-risk retry path:

1. Record the FlowPay attempt UUID, source wallet, intended destination, exact USDC amount, approximate time, and correlation ID without exposing credentials.
2. Query Circle transaction status and search operational records using supported identifiers.
3. If a transaction exists or may exist, keep the attempt frozen and continue polling/escalation.
4. Only when an authorized provider check proves no transfer was created, open the settlement recovery control.
5. Finance records the external evidence reference and reason. FlowPay terminates the old attempt and creates eligibility for a fresh attempt with a new persisted UUIDv4.

## Provider incident / kill switch

- Remove or change `FLOWPAY_PROVIDER` through the controlled Cloudflare environment configuration to stop new execution. With no selected provider, ready work remains durable and pending.
- Do not delete source/destination mappings or financial records during an incident.
- Continue read-only status investigation for already accepted transactions.
- Re-enable only after credentials, network status, balances, and a low-value test have been reviewed.

## Secret compromise

1. Disable provider execution.
2. Revoke/rotate the Circle API key using Circle's current official procedure.
3. Follow Circle's current entity-secret recovery/rotation procedure; do not improvise or log recovery material.
4. Rotate Cloudflare secret bindings in the affected environment.
5. Review audit/provider activity for unauthorized transactions and reconcile every result.
6. Record the incident and approvals outside secrets-bearing logs.

## Required monitoring

Review and alert on:

- oldest undispatched outbox event;
- stale approval count/age;
- unknown submission outcomes;
- pending provider confirmations and observation errors;
- failed settlement/accounting work;
- reconciliation mismatches;
- quarantined queue messages.

The PWA **Operations** page is the persisted financial control view. Cloudflare logs/traces supplement it but are not the sole record.
