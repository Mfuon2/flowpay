import { transitionSettlement, type SettlementState } from "@flowpay/domain";
import type {
  ProviderTransferInput,
  SettlementProvider,
  SubmissionResult,
} from "@flowpay/provider-contract";

import { auditStatement, outboxStatement } from "./evidence-statements.ts";

export type ExecuteSettlementWorkItemResult = Readonly<{
  workItemId: string;
  settlementId: string;
  outcome:
    | "SUBMITTED"
    | "CONFIRMED"
    | "RETRY_SCHEDULED"
    | "TERMINAL_FAILURE"
    | "OUTCOME_UNKNOWN"
    | "ALREADY_COMPLETED";
}>;

export class SettlementExecutionUnavailableError extends Error {
  override readonly name = "SettlementExecutionUnavailableError";
}

type WorkContext = Readonly<{
  work_item_id: string;
  work_status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  settlement_id: string;
  organisation_id: string;
  settlement_state: SettlementState;
  state_version: number;
  asset_code: string;
  asset_scale: number;
  provider_policy_json: string;
  correlation_id: string;
}>;

type DistributionRow = Readonly<{
  id: string;
  beneficiary_id: string;
  amount_atomic: string;
  state: "PENDING" | "SUBMITTING" | "SUBMITTED" | "CONFIRMED" | "FAILED";
  provider: string;
  network: string;
  source_reference: string;
  address: string;
}>;

type ProviderPolicy = Readonly<{
  providerKey: string;
  network: string;
  method: "INDIVIDUAL_TRANSFERS";
}>;

export async function executeSettlementWorkItem(
  database: D1Database,
  workItemId: string,
  providerKey: string,
  provider: SettlementProvider,
): Promise<ExecuteSettlementWorkItemResult> {
  const context = await loadContext(database, workItemId);
  if (context.work_status === "COMPLETED") {
    return completedResult(context);
  }
  if (context.work_status === "FAILED") {
    throw new SettlementExecutionUnavailableError(
      "The execution work item requires an explicit recovery decision.",
    );
  }
  const policy = parseProviderPolicy(context.provider_policy_json);
  if (policy.providerKey !== providerKey) {
    throw new SettlementExecutionUnavailableError(
      "The configured settlement provider does not match the executor.",
    );
  }
  const distributions = await loadDistributions(
    database,
    context,
    providerKey,
    policy.network,
  );
  if (context.work_status === "PROCESSING") {
    const startedAttempt = await database
      .prepare(
        `SELECT id FROM settlement_attempts
         WHERE settlement_distribution_id IN (
           SELECT id FROM settlement_distributions WHERE settlement_id = ?
         ) AND status = 'STARTED' LIMIT 1`,
      )
      .bind(context.settlement_id)
      .first<string>("id");
    if (startedAttempt) {
      await markInterruptedAttemptUnknown(database, context, startedAttempt);
      return result(context, "OUTCOME_UNKNOWN");
    }
  }

  await claimWork(database, context);
  for (const distribution of distributions) {
    if (
      distribution.state === "CONFIRMED" ||
      distribution.state === "SUBMITTED"
    ) {
      continue;
    }
    if (distribution.state !== "PENDING") {
      throw new SettlementExecutionUnavailableError(
        `Distribution ${distribution.id} cannot be submitted from ${distribution.state}.`,
      );
    }
    const destination = await provider.validateDestination({
      network: distribution.network,
      address: distribution.address,
    });
    if (!destination.valid) {
      await failWithoutSubmission(
        database,
        context,
        distribution,
        destination.reason,
      );
      return result(context, "TERMINAL_FAILURE");
    }

    const attemptNumber = await nextAttemptNumber(database, distribution.id);
    const attemptId = crypto.randomUUID();
    // The attempt is persisted before submission, so its UUIDv4 is a stable
    // external idempotency key bound to this exact distribution attempt.
    const idempotencyKey = attemptId;
    const now = new Date().toISOString();
    await database.batch([
      database
        .prepare(
          `INSERT INTO settlement_attempts (
            id, settlement_distribution_id, attempt_number, idempotency_key,
            status, started_at
          ) VALUES (?, ?, ?, ?, 'STARTED', ?)`,
        )
        .bind(attemptId, distribution.id, attemptNumber, idempotencyKey, now),
      database
        .prepare(
          `UPDATE settlement_distributions SET state = 'SUBMITTING', updated_at = ?
           WHERE id = ? AND state = 'PENDING'`,
        )
        .bind(now, distribution.id),
    ]);

    let submission: SubmissionResult;
    try {
      const input: ProviderTransferInput = {
        idempotencyKey,
        sourceReference: distribution.source_reference,
        destination: destination.normalized,
        amount: {
          assetCode: context.asset_code,
          atomicAmount: distribution.amount_atomic,
          scale: context.asset_scale,
        },
        correlationId: context.correlation_id,
      };
      submission = await provider.submitTransfer(input);
    } catch (error) {
      await markThrownSubmissionUnknown(database, context, attemptId, error);
      return result(context, "OUTCOME_UNKNOWN");
    }
    const outcome = await recordSubmission(
      database,
      context,
      distribution,
      attemptId,
      destination.normalized.network,
      providerKey,
      submission,
    );
    if (outcome) return result(context, outcome);
  }

  const finalState = await finalDistributionState(
    database,
    context.settlement_id,
  );
  await finishSettlement(database, context, finalState);
  return result(context, finalState);
}

async function claimWork(
  database: D1Database,
  context: WorkContext,
): Promise<void> {
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (context.settlement_state === "READY") {
    const nextState = transitionSettlement("READY", "BEGIN_SUBMISSION");
    statements.push(
      stateTransitionStatement(
        database,
        context,
        nextState,
        "BEGIN_SUBMISSION",
        now,
      ),
      database
        .prepare(
          `UPDATE settlements SET state = ?, state_version = ?, updated_at = ?
           WHERE id = ? AND state = 'READY' AND state_version = ?`,
        )
        .bind(
          nextState,
          context.state_version + 1,
          now,
          context.settlement_id,
          context.state_version,
        ),
    );
  } else if (context.settlement_state !== "SUBMITTING") {
    throw new SettlementExecutionUnavailableError(
      `Settlement cannot execute from ${context.settlement_state}.`,
    );
  }
  statements.push(
    database
      .prepare(
        `UPDATE settlement_work_items
         SET status = 'PROCESSING', processing_started_at = ?,
             attempt_count = attempt_count + 1, last_error = NULL, updated_at = ?
         WHERE id = ? AND status IN ('PENDING', 'PROCESSING')`,
      )
      .bind(now, now, context.work_item_id),
  );
  await database.batch(statements);
}

async function recordSubmission(
  database: D1Database,
  context: WorkContext,
  distribution: DistributionRow,
  attemptId: string,
  network: string,
  providerKey: string,
  submission: SubmissionResult,
): Promise<"RETRY_SCHEDULED" | "TERMINAL_FAILURE" | "OUTCOME_UNKNOWN" | null> {
  const now = new Date().toISOString();
  if (submission.outcome === "ACCEPTED") {
    const confirmed = submission.state === "CONFIRMED";
    await database.batch([
      database
        .prepare(
          `UPDATE settlement_attempts SET status = ?, completed_at = ? WHERE id = ?`,
        )
        .bind(confirmed ? "CONFIRMED" : "ACCEPTED", now, attemptId),
      providerTransactionStatement(database, {
        attemptId,
        providerKey,
        providerTransactionId: submission.providerTransactionId,
        network,
        networkReference: submission.networkTransactionReference ?? null,
        status: submission.state,
        evidence: {
          outcome: submission.outcome,
          state: submission.state,
          distributionId: distribution.id,
          beneficiaryId: distribution.beneficiary_id,
          destination: {
            network,
            address: distribution.address,
          },
          amount: {
            assetCode: context.asset_code,
            atomicAmount: distribution.amount_atomic,
            scale: context.asset_scale,
          },
        },
        now,
      }),
      database
        .prepare(
          `UPDATE settlement_distributions SET state = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(confirmed ? "CONFIRMED" : "SUBMITTED", now, distribution.id),
      auditStatement(database, {
        id: crypto.randomUUID(),
        organisationId: context.organisation_id,
        actorType: "PROVIDER",
        actorId: providerKey,
        action: confirmed
          ? "DISTRIBUTION_TRANSFER_CONFIRMED"
          : "DISTRIBUTION_TRANSFER_ACCEPTED",
        aggregateType: "SETTLEMENT_DISTRIBUTION",
        aggregateId: distribution.id,
        correlationId: context.correlation_id,
        causationId: attemptId,
        evidence: {
          providerTransactionId: submission.providerTransactionId,
          network,
          state: submission.state,
        },
        occurredAt: now,
      }),
    ]);
    return null;
  }
  if (submission.outcome === "RETRYABLE_FAILURE") {
    const nextAttemptAt = new Date(Date.now() + 30_000).toISOString();
    await database.batch([
      database
        .prepare(
          `UPDATE settlement_attempts
           SET status = 'RETRYABLE_FAILURE', error_code = ?, error_message = ?, completed_at = ?
           WHERE id = ?`,
        )
        .bind(
          submission.code,
          submission.message.slice(0, 500),
          now,
          attemptId,
        ),
      database
        .prepare(
          `UPDATE settlement_distributions SET state = 'PENDING', updated_at = ? WHERE id = ?`,
        )
        .bind(now, distribution.id),
      database
        .prepare(
          `UPDATE settlement_work_items
           SET status = 'PENDING', next_attempt_at = ?, last_error = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(
          nextAttemptAt,
          submission.message.slice(0, 500),
          now,
          context.work_item_id,
        ),
      auditStatement(database, {
        id: crypto.randomUUID(),
        organisationId: context.organisation_id,
        actorType: "PROVIDER",
        actorId: providerKey,
        action: "DISTRIBUTION_TRANSFER_RETRY_SCHEDULED",
        aggregateType: "SETTLEMENT_DISTRIBUTION",
        aggregateId: distribution.id,
        correlationId: context.correlation_id,
        causationId: attemptId,
        evidence: { code: submission.code, nextAttemptAt },
        occurredAt: now,
      }),
    ]);
    return "RETRY_SCHEDULED";
  }
  if (submission.outcome === "TERMINAL_FAILURE") {
    await database
      .prepare(
        `UPDATE settlement_attempts
         SET status = 'TERMINAL_FAILURE', error_code = ?, error_message = ?, completed_at = ?
         WHERE id = ?`,
      )
      .bind(submission.code, submission.message.slice(0, 500), now, attemptId)
      .run();
    await failSettlement(
      database,
      context,
      distribution.id,
      submission.message,
    );
    return "TERMINAL_FAILURE";
  }

  await database.batch([
    database
      .prepare(
        `UPDATE settlement_attempts
         SET status = 'OUTCOME_UNKNOWN', error_code = ?, error_message = ?, completed_at = ?
         WHERE id = ?`,
      )
      .bind(submission.code, submission.message.slice(0, 500), now, attemptId),
    ...("providerTransactionId" in submission &&
    submission.providerTransactionId
      ? [
          providerTransactionStatement(database, {
            attemptId,
            providerKey,
            providerTransactionId: submission.providerTransactionId,
            network,
            networkReference: null,
            status: "UNKNOWN",
            evidence: {
              outcome: submission.outcome,
              code: submission.code,
              distributionId: distribution.id,
              beneficiaryId: distribution.beneficiary_id,
              destination: {
                network,
                address: distribution.address,
              },
              amount: {
                assetCode: context.asset_code,
                atomicAmount: distribution.amount_atomic,
                scale: context.asset_scale,
              },
            },
            now,
          }),
        ]
      : []),
    database
      .prepare(
        `UPDATE settlement_work_items SET status = 'FAILED', last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(submission.message.slice(0, 500), now, context.work_item_id),
    auditStatement(database, {
      id: crypto.randomUUID(),
      organisationId: context.organisation_id,
      actorType: "PROVIDER",
      actorId: providerKey,
      action: "DISTRIBUTION_TRANSFER_OUTCOME_UNKNOWN",
      aggregateType: "SETTLEMENT_DISTRIBUTION",
      aggregateId: distribution.id,
      correlationId: context.correlation_id,
      causationId: attemptId,
      evidence: {
        code: submission.code,
        providerTransactionId:
          "providerTransactionId" in submission
            ? (submission.providerTransactionId ?? null)
            : null,
      },
      occurredAt: now,
    }),
  ]);
  return "OUTCOME_UNKNOWN";
}

async function finishSettlement(
  database: D1Database,
  context: WorkContext,
  state: "SUBMITTED" | "CONFIRMED",
): Promise<void> {
  const current = await loadContext(database, context.work_item_id);
  const now = new Date().toISOString();
  const action = state === "CONFIRMED" ? "CONFIRM" : "ACCEPT_SUBMISSION";
  transitionSettlement(current.settlement_state, action);
  await database.batch([
    stateTransitionStatement(database, current, state, action, now),
    database
      .prepare(
        `UPDATE settlements SET state = ?, state_version = ?, updated_at = ?
         WHERE id = ? AND state = ? AND state_version = ?`,
      )
      .bind(
        state,
        current.state_version + 1,
        now,
        current.settlement_id,
        current.settlement_state,
        current.state_version,
      ),
    database
      .prepare(
        `UPDATE settlement_work_items
         SET status = 'COMPLETED', completed_at = ?, next_attempt_at = NULL,
             last_error = NULL, updated_at = ? WHERE id = ?`,
      )
      .bind(now, now, current.work_item_id),
    auditStatement(database, {
      id: crypto.randomUUID(),
      organisationId: current.organisation_id,
      actorType: "SERVICE",
      actorId: "settlement-executor",
      action: `SETTLEMENT_${state}`,
      aggregateType: "SETTLEMENT",
      aggregateId: current.settlement_id,
      correlationId: current.correlation_id,
      causationId: current.work_item_id,
      evidence: { state },
      occurredAt: now,
    }),
    outboxStatement(database, {
      id: crypto.randomUUID(),
      organisationId: current.organisation_id,
      messageType: `FLOWPAY_SETTLEMENT_${state}`,
      aggregateType: "SETTLEMENT",
      aggregateId: current.settlement_id,
      correlationId: current.correlation_id,
      causationId: current.work_item_id,
      payload: { settlementId: current.settlement_id, state },
      createdAt: now,
    }),
  ]);
}

async function failSettlement(
  database: D1Database,
  context: WorkContext,
  distributionId: string,
  reason: string,
): Promise<void> {
  const current = await loadContext(database, context.work_item_id);
  const now = new Date().toISOString();
  transitionSettlement(current.settlement_state, "FAIL");
  await database.batch([
    database
      .prepare(
        `UPDATE settlement_distributions SET state = 'FAILED', updated_at = ? WHERE id = ?`,
      )
      .bind(now, distributionId),
    stateTransitionStatement(database, current, "FAILED", "FAIL", now, reason),
    database
      .prepare(
        `UPDATE settlements SET state = 'FAILED', state_version = ?, updated_at = ? WHERE id = ? AND state = ? AND state_version = ?`,
      )
      .bind(
        current.state_version + 1,
        now,
        current.settlement_id,
        current.settlement_state,
        current.state_version,
      ),
    database
      .prepare(
        `UPDATE settlement_work_items SET status = 'FAILED', last_error = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(reason.slice(0, 500), now, current.work_item_id),
    auditStatement(database, {
      id: crypto.randomUUID(),
      organisationId: current.organisation_id,
      actorType: "SERVICE",
      actorId: "settlement-executor",
      action: "SETTLEMENT_EXECUTION_FAILED",
      aggregateType: "SETTLEMENT",
      aggregateId: current.settlement_id,
      correlationId: current.correlation_id,
      causationId: current.work_item_id,
      evidence: { distributionId, reason: reason.slice(0, 500) },
      occurredAt: now,
    }),
  ]);
}

async function failWithoutSubmission(
  database: D1Database,
  context: WorkContext,
  distribution: DistributionRow,
  reason: string,
): Promise<void> {
  await failSettlement(database, context, distribution.id, reason);
}

async function markThrownSubmissionUnknown(
  database: D1Database,
  context: WorkContext,
  attemptId: string,
  error: unknown,
): Promise<void> {
  const message =
    error instanceof Error
      ? error.message
      : "Provider submission threw an unknown error.";
  const now = new Date().toISOString();
  await database.batch([
    database
      .prepare(
        `UPDATE settlement_attempts SET status = 'OUTCOME_UNKNOWN', error_code = 'PROVIDER_EXCEPTION', error_message = ?, completed_at = ? WHERE id = ?`,
      )
      .bind(message.slice(0, 500), now, attemptId),
    database
      .prepare(
        `UPDATE settlement_work_items SET status = 'FAILED', last_error = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(message.slice(0, 500), now, context.work_item_id),
    auditStatement(database, {
      id: crypto.randomUUID(),
      organisationId: context.organisation_id,
      actorType: "SERVICE",
      actorId: "settlement-executor",
      action: "PROVIDER_SUBMISSION_OUTCOME_UNKNOWN",
      aggregateType: "SETTLEMENT",
      aggregateId: context.settlement_id,
      correlationId: context.correlation_id,
      causationId: attemptId,
      evidence: { error: message.slice(0, 500) },
      occurredAt: now,
    }),
  ]);
}

async function markInterruptedAttemptUnknown(
  database: D1Database,
  context: WorkContext,
  attemptId: string,
): Promise<void> {
  const message =
    "A prior provider request was interrupted before its outcome was persisted.";
  await markThrownSubmissionUnknown(
    database,
    context,
    attemptId,
    new Error(message),
  );
}

function providerTransactionStatement(
  database: D1Database,
  input: {
    attemptId: string;
    providerKey: string;
    providerTransactionId: string;
    network: string;
    networkReference: string | null;
    status: string;
    evidence: object;
    now: string;
  },
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO settlement_provider_transactions (id, settlement_attempt_id, provider, provider_transaction_id, network, network_transaction_reference, status, evidence_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.attemptId,
      input.providerKey,
      input.providerTransactionId,
      input.network,
      input.networkReference,
      input.status,
      JSON.stringify(input.evidence),
      input.now,
      input.now,
    );
}

function stateTransitionStatement(
  database: D1Database,
  context: WorkContext,
  toState: SettlementState,
  action: string,
  now: string,
  reason?: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO settlement_state_transitions (id, organisation_id, settlement_id, from_state, to_state, from_version, to_version, action, actor_type, actor_id, reason, correlation_id, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SERVICE', 'settlement-executor', ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      context.organisation_id,
      context.settlement_id,
      context.settlement_state,
      toState,
      context.state_version,
      context.state_version + 1,
      action,
      reason ?? null,
      context.correlation_id,
      now,
    );
}

async function loadContext(
  database: D1Database,
  workItemId: string,
): Promise<WorkContext> {
  const row = await database
    .prepare(
      `SELECT wi.id AS work_item_id, wi.status AS work_status, s.id AS settlement_id, s.organisation_id, s.state AS settlement_state, s.state_version, s.asset_code, s.asset_scale, srv.provider_policy_json, be.correlation_id FROM settlement_work_items wi JOIN settlements s ON s.id = wi.settlement_id JOIN settlement_rule_versions srv ON srv.id = s.rule_version_id JOIN business_events be ON be.id = s.source_event_id WHERE wi.id = ?`,
    )
    .bind(workItemId)
    .first<WorkContext>();
  if (!row)
    throw new SettlementExecutionUnavailableError(
      "Settlement execution work item was not found.",
    );
  return row;
}

async function loadDistributions(
  database: D1Database,
  context: WorkContext,
  providerKey: string,
  network: string,
): Promise<readonly DistributionRow[]> {
  const rows = await database
    .prepare(
      `SELECT sd.id, sd.beneficiary_id, sd.amount_atomic, sd.state,
              src.provider, src.network, src.source_reference, dest.address
       FROM settlement_distributions sd
       JOIN settlement_provider_sources src
         ON src.organisation_id = ? AND src.provider = ?
        AND src.network = ? AND src.status = 'ACTIVE'
       JOIN participant_settlement_destinations dest
         ON dest.organisation_id = ?
        AND dest.participant_id = sd.beneficiary_id
        AND dest.provider = src.provider AND dest.network = src.network
        AND dest.status = 'ACTIVE'
       WHERE sd.settlement_id = ? ORDER BY sd.position`,
    )
    .bind(
      context.organisation_id,
      providerKey,
      network,
      context.organisation_id,
      context.settlement_id,
    )
    .all<DistributionRow>();
  const expected = await database
    .prepare(
      `SELECT COUNT(*) AS count FROM settlement_distributions WHERE settlement_id = ?`,
    )
    .bind(context.settlement_id)
    .first<number>("count");
  if (rows.results.length !== expected)
    throw new SettlementExecutionUnavailableError(
      "Every distribution requires one active provider destination and source.",
    );
  return rows.results;
}

async function nextAttemptNumber(
  database: D1Database,
  distributionId: string,
): Promise<number> {
  const count = await database
    .prepare(
      `SELECT COUNT(*) AS count FROM settlement_attempts WHERE settlement_distribution_id = ?`,
    )
    .bind(distributionId)
    .first<number>("count");
  return (count ?? 0) + 1;
}

async function finalDistributionState(
  database: D1Database,
  settlementId: string,
): Promise<"SUBMITTED" | "CONFIRMED"> {
  const pending = await database
    .prepare(
      `SELECT COUNT(*) AS count FROM settlement_distributions WHERE settlement_id = ? AND state <> 'CONFIRMED'`,
    )
    .bind(settlementId)
    .first<number>("count");
  return pending === 0 ? "CONFIRMED" : "SUBMITTED";
}

function parseProviderPolicy(value: string): ProviderPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new SettlementExecutionUnavailableError(
      "Provider policy is invalid JSON.",
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("providerKey" in parsed) ||
    typeof parsed.providerKey !== "string" ||
    parsed.providerKey.trim().length === 0 ||
    !("network" in parsed) ||
    typeof parsed.network !== "string" ||
    parsed.network.trim().length === 0 ||
    !("method" in parsed) ||
    parsed.method !== "INDIVIDUAL_TRANSFERS"
  )
    throw new SettlementExecutionUnavailableError(
      "Provider policy must select a provider, network, and individual transfers.",
    );
  return {
    providerKey: parsed.providerKey,
    network: parsed.network,
    method: parsed.method,
  };
}

function completedResult(
  context: WorkContext,
): ExecuteSettlementWorkItemResult {
  return result(context, "ALREADY_COMPLETED");
}

function result(
  context: WorkContext,
  outcome: ExecuteSettlementWorkItemResult["outcome"],
): ExecuteSettlementWorkItemResult {
  return {
    workItemId: context.work_item_id,
    settlementId: context.settlement_id,
    outcome,
  };
}
