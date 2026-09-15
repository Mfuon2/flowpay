import type { FlowPayQueueMessage } from "./outbox.ts";

const CONSUMER_NAME = "flowpay-events-v1";

const KNOWN_MESSAGE_TYPES: readonly string[] = [
  "FLOWPAY_RULE_EVALUATION_COMPLETED",
  "FLOWPAY_SETTLEMENT_CREATED",
  "FLOWPAY_APPROVAL_DECISION_RECORDED",
  "FLOWPAY_SETTLEMENT_READY",
  "FLOWPAY_SETTLEMENT_APPROVAL_REJECTED",
  "FLOWPAY_SETTLEMENT_CANCELLED",
  "FLOWPAY_SETTLEMENT_SUBMITTED",
  "FLOWPAY_SETTLEMENT_CONFIRMED",
  "ACCOUNTING_JOURNAL_POSTED",
  "ACCOUNTING_RECONCILIATION_COMPLETED",
  "BUSINESS_PAYMENT_CONFIRMED",
  "BUSINESS_INVOICE_ISSUED",
  "BUSINESS_QUOTE_APPROVED",
  "BUSINESS_JOB_STARTED",
  "BUSINESS_JOB_COMPLETED",
  "BUSINESS_JOB_CANCELLED",
];

export class PermanentQueueMessageError extends Error {
  override readonly name = "PermanentQueueMessageError";
}

type InboxRow = Readonly<{ completed_at: string | null }>;

export async function consumeFlowPayMessage(
  database: D1Database,
  value: unknown,
): Promise<"PROCESSED" | "DUPLICATE"> {
  const message = parseQueueMessage(value);
  const existing = await database
    .prepare(
      `SELECT completed_at FROM inbox_messages
       WHERE consumer_name = ? AND message_id = ?`,
    )
    .bind(CONSUMER_NAME, message.messageId)
    .first<InboxRow>();
  if (existing?.completed_at) return "DUPLICATE";

  const now = new Date().toISOString();
  await database
    .prepare(
      `INSERT OR IGNORE INTO inbox_messages (
        consumer_name, message_id, received_at
      ) VALUES (?, ?, ?)`,
    )
    .bind(CONSUMER_NAME, message.messageId, now)
    .run();

  const statements: D1PreparedStatement[] = [];
  if (message.messageType === "FLOWPAY_SETTLEMENT_READY") {
    const settlementId = settlementIdFromPayload(message.payloadJson);
    statements.push(
      database
        .prepare(
          `INSERT OR IGNORE INTO settlement_work_items (
            id, organisation_id, source_message_id, settlement_id,
            work_type, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'EXECUTE_SETTLEMENT', 'PENDING', ?, ?)`,
        )
        .bind(
          message.messageId,
          message.organisationId,
          message.messageId,
          settlementId,
          now,
          now,
        ),
    );
  }
  if (message.messageType === "FLOWPAY_SETTLEMENT_CONFIRMED") {
    const settlementId = settlementIdFromPayload(message.payloadJson);
    statements.push(
      database
        .prepare(
          `INSERT OR IGNORE INTO accounting_work_items (
            id, organisation_id, source_message_id, settlement_id,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`,
        )
        .bind(
          message.messageId,
          message.organisationId,
          message.messageId,
          settlementId,
          now,
          now,
        ),
    );
  }
  statements.push(
    database
      .prepare(
        `UPDATE inbox_messages
         SET completed_at = ?, last_error = NULL
         WHERE consumer_name = ? AND message_id = ?`,
      )
      .bind(now, CONSUMER_NAME, message.messageId),
  );
  await database.batch(statements);
  return "PROCESSED";
}

export async function recordPermanentQueueFailure(
  database: D1Database,
  queueName: string,
  queueMessageId: string,
  attempts: number,
  error: PermanentQueueMessageError,
  organisationId?: string,
): Promise<void> {
  await database
    .prepare(
      `INSERT OR IGNORE INTO queue_message_failures (
        id, queue_name, queue_message_id, attempts, error_code,
        error_message, recorded_at, organisation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?,
        CASE WHEN EXISTS (SELECT 1 FROM organisations WHERE id = ?) THEN ? ELSE NULL END
      )`,
    )
    .bind(
      crypto.randomUUID(),
      queueName,
      queueMessageId,
      Math.max(1, attempts),
      error.name,
      error.message.slice(0, 500),
      new Date().toISOString(),
      organisationId ?? null,
      organisationId ?? null,
    )
    .run();
}

function parseQueueMessage(value: unknown): FlowPayQueueMessage {
  if (
    !isRecord(value) ||
    !isIdentifier(value.messageId) ||
    !isIdentifier(value.organisationId) ||
    !isIdentifier(value.messageType) ||
    typeof value.schemaVersion !== "number" ||
    !Number.isSafeInteger(value.schemaVersion) ||
    value.schemaVersion !== 1 ||
    !isIdentifier(value.aggregateType) ||
    !isIdentifier(value.aggregateId) ||
    !isIdentifier(value.correlationId) ||
    !(value.causationId === null || isIdentifier(value.causationId)) ||
    typeof value.payloadJson !== "string" ||
    !isIdentifier(value.createdAt)
  ) {
    throw new PermanentQueueMessageError(
      "Queue message does not match the FlowPay v1 envelope.",
    );
  }
  if (!KNOWN_MESSAGE_TYPES.includes(value.messageType)) {
    throw new PermanentQueueMessageError(
      `Unsupported FlowPay message type: ${value.messageType}.`,
    );
  }
  return {
    messageId: value.messageId,
    organisationId: value.organisationId,
    messageType: value.messageType,
    schemaVersion: value.schemaVersion,
    aggregateType: value.aggregateType,
    aggregateId: value.aggregateId,
    correlationId: value.correlationId,
    causationId: value.causationId,
    payloadJson: value.payloadJson,
    createdAt: value.createdAt,
  };
}

function settlementIdFromPayload(payloadJson: string): string {
  let value: unknown;
  try {
    value = JSON.parse(payloadJson) as unknown;
  } catch {
    throw new PermanentQueueMessageError(
      "Settlement-ready payload is not valid JSON.",
    );
  }
  if (!isRecord(value) || !isIdentifier(value.settlementId)) {
    throw new PermanentQueueMessageError(
      "Settlement-ready payload has no settlement ID.",
    );
  }
  return value.settlementId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value === value.trim()
  );
}
