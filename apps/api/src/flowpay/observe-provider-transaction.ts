import { transitionSettlement, type SettlementState } from "@flowpay/domain";
import type { SettlementProvider } from "@flowpay/provider-contract";

import { auditStatement, outboxStatement } from "./evidence-statements.ts";

export type ObserveProviderTransactionResult = Readonly<{
  providerTransactionRecordId: string;
  settlementId: string;
  distributionId: string;
  outcome: "NOT_FOUND" | "PENDING" | "CONFIRMED" | "FAILED" | "UNCHANGED";
  settlementState: SettlementState;
}>;

export class ProviderObservationUnavailableError extends Error {
  override readonly name = "ProviderObservationUnavailableError";
}

type ObservationContext = Readonly<{
  provider_transaction_record_id: string;
  provider: string;
  provider_transaction_id: string | null;
  provider_status: string;
  network_transaction_reference: string | null;
  attempt_id: string;
  attempt_status: string;
  distribution_id: string;
  distribution_state: string;
  settlement_id: string;
  organisation_id: string;
  settlement_state: SettlementState;
  state_version: number;
  correlation_id: string;
  work_item_id: string;
}>;

export async function observeProviderTransaction(
  database: D1Database,
  providerTransactionRecordId: string,
  providerKey: string,
  provider: SettlementProvider,
): Promise<ObserveProviderTransactionResult> {
  const context = await loadObservationContext(
    database,
    providerTransactionRecordId,
  );
  if (context.provider !== providerKey) {
    throw new ProviderObservationUnavailableError(
      "The transaction provider does not match the observer.",
    );
  }
  if (!context.provider_transaction_id) {
    throw new ProviderObservationUnavailableError(
      "The provider transaction has no external transaction identity.",
    );
  }

  const observed = await provider.getTransaction(
    context.provider_transaction_id,
  );
  if (observed.outcome === "NOT_FOUND") {
    return result(context, "NOT_FOUND", context.settlement_state);
  }
  if (observed.providerTransactionId !== context.provider_transaction_id) {
    throw new ProviderObservationUnavailableError(
      "The provider returned a different transaction identity.",
    );
  }

  if (
    observed.state === context.provider_status &&
    (observed.networkTransactionReference ?? null) ===
      context.network_transaction_reference
  ) {
    return result(context, "UNCHANGED", context.settlement_state);
  }
  if (observed.state === "PENDING") {
    await recordPendingObservation(
      database,
      context,
      observed.networkTransactionReference ?? null,
    );
    return result(context, "PENDING", context.settlement_state);
  }
  if (observed.state === "CONFIRMED") {
    const settlementState = await recordConfirmation(
      database,
      context,
      observed.networkTransactionReference ?? null,
    );
    return result(context, "CONFIRMED", settlementState);
  }

  const settlementState = await recordFailure(
    database,
    context,
    observed.state,
    observed.failureCode ?? null,
  );
  return result(context, "FAILED", settlementState);
}

async function recordPendingObservation(
  database: D1Database,
  context: ObservationContext,
  networkTransactionReference: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  await database.batch([
    database
      .prepare(
        `UPDATE settlement_provider_transactions
         SET status = 'PENDING', network_transaction_reference = ?,
             evidence_json = json_set(evidence_json, '$.lastObservation', json(?)),
             updated_at = ? WHERE id = ?`,
      )
      .bind(
        networkTransactionReference,
        JSON.stringify({
          source: "STATUS_LOOKUP",
          state: "PENDING",
          observedAt: now,
        }),
        now,
        context.provider_transaction_record_id,
      ),
    auditStatement(database, {
      id: crypto.randomUUID(),
      organisationId: context.organisation_id,
      actorType: "PROVIDER",
      actorId: context.provider,
      action: "PROVIDER_TRANSACTION_PENDING",
      aggregateType: "SETTLEMENT_DISTRIBUTION",
      aggregateId: context.distribution_id,
      correlationId: context.correlation_id,
      causationId: context.provider_transaction_record_id,
      evidence: {
        providerTransactionId: context.provider_transaction_id,
        state: "PENDING",
      },
      occurredAt: now,
    }),
  ]);
}

async function recordConfirmation(
  database: D1Database,
  context: ObservationContext,
  networkReference: string | null,
): Promise<SettlementState> {
  const now = new Date().toISOString();
  await database.batch([
    database
      .prepare(
        `UPDATE settlement_provider_transactions
         SET status = 'CONFIRMED', network_transaction_reference = ?,
             evidence_json = json_set(evidence_json, '$.lastObservation', json(?)),
             updated_at = ? WHERE id = ?`,
      )
      .bind(
        networkReference,
        JSON.stringify({
          source: "STATUS_LOOKUP",
          state: "CONFIRMED",
          observedAt: now,
        }),
        now,
        context.provider_transaction_record_id,
      ),
    database
      .prepare(
        `UPDATE settlement_attempts
         SET status = 'CONFIRMED', completed_at = ?, error_code = NULL,
             error_message = NULL WHERE id = ?`,
      )
      .bind(now, context.attempt_id),
    database
      .prepare(
        `UPDATE settlement_distributions
         SET state = 'CONFIRMED', updated_at = ? WHERE id = ?`,
      )
      .bind(now, context.distribution_id),
    auditStatement(database, {
      id: crypto.randomUUID(),
      organisationId: context.organisation_id,
      actorType: "PROVIDER",
      actorId: context.provider,
      action: "DISTRIBUTION_TRANSFER_CONFIRMED",
      aggregateType: "SETTLEMENT_DISTRIBUTION",
      aggregateId: context.distribution_id,
      correlationId: context.correlation_id,
      causationId: context.provider_transaction_record_id,
      evidence: {
        providerTransactionId: context.provider_transaction_id,
        networkTransactionReference: networkReference,
      },
      occurredAt: now,
    }),
  ]);

  const outstanding = await database
    .prepare(
      `SELECT COUNT(*) AS count FROM settlement_distributions
       WHERE settlement_id = ? AND state <> 'CONFIRMED'`,
    )
    .bind(context.settlement_id)
    .first<number>("count");
  const current = await loadObservationContext(
    database,
    context.provider_transaction_record_id,
  );
  if (outstanding === 0 && current.settlement_state !== "CONFIRMED") {
    if (
      current.settlement_state !== "SUBMITTED" &&
      current.settlement_state !== "SUBMITTING"
    ) {
      throw new ProviderObservationUnavailableError(
        `Settlement cannot confirm from ${current.settlement_state}.`,
      );
    }
    await confirmParentSettlement(database, current, now);
    return "CONFIRMED";
  }
  if (current.settlement_state === "SUBMITTING") {
    await database
      .prepare(
        `UPDATE settlement_work_items
         SET status = 'PENDING', next_attempt_at = NULL, last_error = NULL,
             updated_at = ? WHERE id = ?`,
      )
      .bind(now, current.work_item_id)
      .run();
  }
  return current.settlement_state;
}

async function confirmParentSettlement(
  database: D1Database,
  context: ObservationContext,
  now: string,
): Promise<void> {
  transitionSettlement(context.settlement_state, "CONFIRM");
  await database.batch([
    transitionStatement(database, context, "CONFIRMED", "CONFIRM", now),
    database
      .prepare(
        `UPDATE settlements SET state = 'CONFIRMED', state_version = ?, updated_at = ?
         WHERE id = ? AND state = ? AND state_version = ?`,
      )
      .bind(
        context.state_version + 1,
        now,
        context.settlement_id,
        context.settlement_state,
        context.state_version,
      ),
    database
      .prepare(
        `UPDATE settlement_work_items
         SET status = 'COMPLETED', completed_at = ?, next_attempt_at = NULL,
             last_error = NULL, updated_at = ? WHERE id = ?`,
      )
      .bind(now, now, context.work_item_id),
    auditStatement(database, {
      id: crypto.randomUUID(),
      organisationId: context.organisation_id,
      actorType: "SERVICE",
      actorId: "provider-status-observer",
      action: "SETTLEMENT_CONFIRMED",
      aggregateType: "SETTLEMENT",
      aggregateId: context.settlement_id,
      correlationId: context.correlation_id,
      causationId: context.provider_transaction_record_id,
      evidence: { allDistributionsConfirmed: true },
      occurredAt: now,
    }),
    outboxStatement(database, {
      id: crypto.randomUUID(),
      organisationId: context.organisation_id,
      messageType: "FLOWPAY_SETTLEMENT_CONFIRMED",
      aggregateType: "SETTLEMENT",
      aggregateId: context.settlement_id,
      correlationId: context.correlation_id,
      causationId: context.provider_transaction_record_id,
      payload: { settlementId: context.settlement_id, state: "CONFIRMED" },
      createdAt: now,
    }),
  ]);
}

async function recordFailure(
  database: D1Database,
  context: ObservationContext,
  providerState: "FAILED" | "CANCELLED",
  failureCode: string | null,
): Promise<SettlementState> {
  const now = new Date().toISOString();
  const reason = failureCode ?? `Provider reported ${providerState}.`;
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `UPDATE settlement_provider_transactions
         SET status = ?,
             evidence_json = json_set(evidence_json, '$.lastObservation', json(?)),
             updated_at = ? WHERE id = ?`,
      )
      .bind(
        providerState,
        JSON.stringify({
          source: "STATUS_LOOKUP",
          state: providerState,
          failureCode,
          observedAt: now,
        }),
        now,
        context.provider_transaction_record_id,
      ),
    database
      .prepare(
        `UPDATE settlement_attempts
         SET status = 'TERMINAL_FAILURE', error_code = ?, error_message = ?,
             completed_at = ? WHERE id = ?`,
      )
      .bind(failureCode, reason, now, context.attempt_id),
    database
      .prepare(
        `UPDATE settlement_distributions SET state = 'FAILED', updated_at = ?
         WHERE id = ?`,
      )
      .bind(now, context.distribution_id),
  ];
  if (
    context.settlement_state === "SUBMITTED" ||
    context.settlement_state === "SUBMITTING"
  ) {
    transitionSettlement(context.settlement_state, "FAIL");
    statements.push(
      transitionStatement(database, context, "FAILED", "FAIL", now, reason),
      database
        .prepare(
          `UPDATE settlements SET state = 'FAILED', state_version = ?, updated_at = ?
           WHERE id = ? AND state = ? AND state_version = ?`,
        )
        .bind(
          context.state_version + 1,
          now,
          context.settlement_id,
          context.settlement_state,
          context.state_version,
        ),
      database
        .prepare(
          `UPDATE settlement_work_items SET status = 'FAILED', last_error = ?,
                  updated_at = ? WHERE id = ?`,
        )
        .bind(reason.slice(0, 500), now, context.work_item_id),
    );
  }
  statements.push(
    auditStatement(database, {
      id: crypto.randomUUID(),
      organisationId: context.organisation_id,
      actorType: "PROVIDER",
      actorId: context.provider,
      action: "PROVIDER_TRANSACTION_FAILED",
      aggregateType: "SETTLEMENT_DISTRIBUTION",
      aggregateId: context.distribution_id,
      correlationId: context.correlation_id,
      causationId: context.provider_transaction_record_id,
      evidence: { providerState, failureCode },
      occurredAt: now,
    }),
  );
  await database.batch(statements);
  return context.settlement_state === "CONFIRMED"
    ? context.settlement_state
    : "FAILED";
}

function transitionStatement(
  database: D1Database,
  context: ObservationContext,
  toState: SettlementState,
  action: string,
  now: string,
  reason?: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO settlement_state_transitions (
        id, organisation_id, settlement_id, from_state, to_state,
        from_version, to_version, action, actor_type, actor_id, reason,
        correlation_id, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SERVICE',
                'provider-status-observer', ?, ?, ?)`,
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

async function loadObservationContext(
  database: D1Database,
  recordId: string,
): Promise<ObservationContext> {
  const row = await database
    .prepare(
      `SELECT spt.id AS provider_transaction_record_id, spt.provider,
              spt.provider_transaction_id, spt.status AS provider_status,
              spt.network_transaction_reference, sa.id AS attempt_id,
              sa.status AS attempt_status, sd.id AS distribution_id,
              sd.state AS distribution_state, s.id AS settlement_id,
              s.organisation_id, s.state AS settlement_state, s.state_version,
              be.correlation_id, wi.id AS work_item_id
       FROM settlement_provider_transactions spt
       JOIN settlement_attempts sa ON sa.id = spt.settlement_attempt_id
       JOIN settlement_distributions sd ON sd.id = sa.settlement_distribution_id
       JOIN settlements s ON s.id = sd.settlement_id
       JOIN business_events be ON be.id = s.source_event_id
       JOIN settlement_work_items wi ON wi.settlement_id = s.id
       WHERE spt.id = ?`,
    )
    .bind(recordId)
    .first<ObservationContext>();
  if (!row) {
    throw new ProviderObservationUnavailableError(
      "Provider transaction record was not found.",
    );
  }
  return row;
}

function result(
  context: ObservationContext,
  outcome: ObserveProviderTransactionResult["outcome"],
  settlementState: SettlementState,
): ObserveProviderTransactionResult {
  return {
    providerTransactionRecordId: context.provider_transaction_record_id,
    settlementId: context.settlement_id,
    distributionId: context.distribution_id,
    outcome,
    settlementState,
  };
}
