import { hashCanonicalJson } from "./canonical-json.ts";
import { auditStatement } from "./evidence-statements.ts";

export type RecordSettlementRecoveryCommand = Readonly<{
  decisionId: string;
  organisationId: string;
  settlementId: string;
  attemptId: string;
  actorId: string;
  action: "RETRY_CONFIRMED_NOT_SUBMITTED";
  reason: string;
  evidenceReference: string;
  decidedAt: string;
}>;

export type RecordSettlementRecoveryResult = Readonly<{
  decisionId: string;
  settlementId: string;
  attemptId: string;
  outcome: "RETRY_SCHEDULED";
  replayed: boolean;
}>;

type Context = Readonly<{
  attempt_id: string;
  distribution_id: string;
  correlation_id: string;
  work_item_id: string;
}>;

type Existing = Readonly<{
  settlement_id: string;
  settlement_attempt_id: string;
  command_fingerprint: string;
}>;

export class SettlementRecoveryConflictError extends Error {
  override readonly name = "SettlementRecoveryConflictError";
}

export class SettlementRecoveryUnavailableError extends Error {
  override readonly name = "SettlementRecoveryUnavailableError";
}

export async function recordSettlementRecovery(
  database: D1Database,
  command: RecordSettlementRecoveryCommand,
): Promise<RecordSettlementRecoveryResult> {
  const normalized = {
    decisionId: required("Decision ID", command.decisionId),
    organisationId: required("Organisation ID", command.organisationId),
    settlementId: required("Settlement ID", command.settlementId),
    attemptId: required("Attempt ID", command.attemptId),
    actorId: required("Actor ID", command.actorId),
    action: command.action,
    reason: required("Recovery reason", command.reason),
    evidenceReference: required(
      "Recovery evidence reference",
      command.evidenceReference,
    ),
    decidedAt: timestamp(command.decidedAt),
  };
  const fingerprint = await hashCanonicalJson(normalized);
  const existing = await findExisting(database, normalized.decisionId);
  if (existing) return replay(existing, normalized, fingerprint);
  const context = await database
    .prepare(
      `SELECT sa.id AS attempt_id, sd.id AS distribution_id,
              be.correlation_id, wi.id AS work_item_id
       FROM settlement_attempts sa
       JOIN settlement_distributions sd ON sd.id = sa.settlement_distribution_id
       JOIN settlements s ON s.id = sd.settlement_id
       JOIN business_events be ON be.id = s.source_event_id
       JOIN settlement_work_items wi ON wi.settlement_id = s.id
       WHERE sa.id = ? AND sa.status = 'OUTCOME_UNKNOWN'
         AND sd.state = 'SUBMITTING'
         AND s.id = ? AND s.organisation_id = ? AND s.state = 'SUBMITTING'
         AND wi.status = 'FAILED'
         AND NOT EXISTS (
           SELECT 1 FROM settlement_provider_transactions spt
           WHERE spt.settlement_attempt_id = sa.id
             AND spt.provider_transaction_id IS NOT NULL
         )`,
    )
    .bind(
      normalized.attemptId,
      normalized.settlementId,
      normalized.organisationId,
    )
    .first<Context>();
  if (!context) {
    throw new SettlementRecoveryUnavailableError(
      "Recovery requires an unresolved unknown attempt with documented provider non-submission evidence.",
    );
  }
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO settlement_recovery_decisions (
            id, organisation_id, settlement_id, settlement_attempt_id,
            action, actor_id, reason, evidence_reference,
            command_fingerprint, decided_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          normalized.decisionId,
          normalized.organisationId,
          normalized.settlementId,
          normalized.attemptId,
          normalized.action,
          normalized.actorId,
          normalized.reason,
          normalized.evidenceReference,
          fingerprint,
          normalized.decidedAt,
        ),
      database
        .prepare(
          `UPDATE settlement_attempts
           SET status = 'TERMINAL_FAILURE', error_code = 'OPERATOR_CONFIRMED_NOT_SUBMITTED',
               error_message = ?, completed_at = ?
           WHERE id = ? AND status = 'OUTCOME_UNKNOWN'`,
        )
        .bind(normalized.reason, normalized.decidedAt, normalized.attemptId),
      database
        .prepare(
          `UPDATE settlement_distributions SET state = 'PENDING', updated_at = ?
           WHERE id = ? AND state = 'SUBMITTING'`,
        )
        .bind(normalized.decidedAt, context.distribution_id),
      database
        .prepare(
          `UPDATE settlement_work_items
           SET status = 'PENDING', processing_started_at = NULL,
               next_attempt_at = ?, last_error = NULL, updated_at = ?
           WHERE id = ? AND status = 'FAILED'`,
        )
        .bind(normalized.decidedAt, normalized.decidedAt, context.work_item_id),
      auditStatement(database, {
        id: crypto.randomUUID(),
        organisationId: normalized.organisationId,
        actorType: "USER",
        actorId: normalized.actorId,
        action: "SETTLEMENT_RETRY_AUTHORIZED_AFTER_PROVIDER_VERIFICATION",
        aggregateType: "SETTLEMENT",
        aggregateId: normalized.settlementId,
        correlationId: context.correlation_id,
        causationId: normalized.decisionId,
        evidence: {
          attemptId: normalized.attemptId,
          action: normalized.action,
          reason: normalized.reason,
          evidenceReference: normalized.evidenceReference,
        },
        occurredAt: normalized.decidedAt,
      }),
    ]);
  } catch (error) {
    const raced = await findExisting(database, normalized.decisionId);
    if (raced) return replay(raced, normalized, fingerprint);
    throw error;
  }
  return result(normalized, false);
}

async function findExisting(
  database: D1Database,
  id: string,
): Promise<Existing | null> {
  return database
    .prepare(
      `SELECT settlement_id, settlement_attempt_id, command_fingerprint
       FROM settlement_recovery_decisions WHERE id = ?`,
    )
    .bind(id)
    .first<Existing>();
}

function replay(
  existing: Existing,
  command: RecordSettlementRecoveryCommand,
  fingerprint: string,
): RecordSettlementRecoveryResult {
  if (
    existing.settlement_id !== command.settlementId ||
    existing.settlement_attempt_id !== command.attemptId ||
    existing.command_fingerprint !== fingerprint
  ) {
    throw new SettlementRecoveryConflictError(
      "The recovery decision identity was already used for different evidence.",
    );
  }
  return result(command, true);
}

function result(
  command: Pick<
    RecordSettlementRecoveryCommand,
    "decisionId" | "settlementId" | "attemptId"
  >,
  replayed: boolean,
): RecordSettlementRecoveryResult {
  return {
    decisionId: command.decisionId,
    settlementId: command.settlementId,
    attemptId: command.attemptId,
    outcome: "RETRY_SCHEDULED",
    replayed,
  };
}

function required(label: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} is required.`);
  if (normalized.length > 500) throw new TypeError(`${label} is too long.`);
  return normalized;
}

function timestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError("Recovery decision time must be ISO 8601.");
  }
  return value;
}
