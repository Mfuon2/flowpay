export type FlowPayQueueMessage = Readonly<{
  messageId: string;
  organisationId: string;
  messageType: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  correlationId: string;
  causationId: string | null;
  payloadJson: string;
  createdAt: string;
}>;

export type OutboxDispatchResult = Readonly<{
  selected: number;
  dispatched: number;
  failed: number;
}>;

type OutboxRow = Readonly<{
  id: string;
  organisation_id: string;
  message_type: string;
  schema_version: number;
  aggregate_type: string;
  aggregate_id: string;
  correlation_id: string;
  causation_id: string | null;
  payload_json: string;
  created_at: string;
  dispatch_attempts: number;
}>;

export type FlowPayQueueSender = Pick<Queue<FlowPayQueueMessage>, "send">;

export async function dispatchPendingOutbox(
  database: D1Database,
  queue: FlowPayQueueSender,
  limit = 25,
): Promise<OutboxDispatchResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError(
      "Outbox dispatch limit must be an integer from 1 to 100.",
    );
  }
  const now = new Date();
  const rows = await database
    .prepare(
      `SELECT id, organisation_id, message_type, schema_version,
              aggregate_type, aggregate_id, correlation_id, causation_id,
              payload_json, created_at, dispatch_attempts
       FROM outbox_messages
       WHERE dispatched_at IS NULL
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at, id
       LIMIT ?`,
    )
    .bind(now.toISOString(), limit)
    .all<OutboxRow>();

  let dispatched = 0;
  let failed = 0;
  for (const row of rows.results) {
    try {
      validateStoredPayload(row.payload_json);
      await queue.send(toQueueMessage(row), { contentType: "json" });
      await database
        .prepare(
          `UPDATE outbox_messages
           SET dispatched_at = ?, dispatch_attempts = dispatch_attempts + 1,
               next_attempt_at = NULL, last_error = NULL
           WHERE id = ? AND dispatched_at IS NULL`,
        )
        .bind(now.toISOString(), row.id)
        .run();
      dispatched += 1;
    } catch (error) {
      const nextAttemptAt = new Date(
        now.getTime() + retryDelayMilliseconds(row.dispatch_attempts + 1),
      ).toISOString();
      await database
        .prepare(
          `UPDATE outbox_messages
           SET dispatch_attempts = dispatch_attempts + 1,
               next_attempt_at = ?, last_error = ?
           WHERE id = ? AND dispatched_at IS NULL`,
        )
        .bind(nextAttemptAt, safeErrorMessage(error), row.id)
        .run();
      failed += 1;
    }
  }
  return { selected: rows.results.length, dispatched, failed };
}

function toQueueMessage(row: OutboxRow): FlowPayQueueMessage {
  return {
    messageId: row.id,
    organisationId: row.organisation_id,
    messageType: row.message_type,
    schemaVersion: row.schema_version,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
  };
}

function validateStoredPayload(payloadJson: string): void {
  try {
    JSON.parse(payloadJson);
  } catch {
    throw new TypeError("Outbox payload is not valid JSON.");
  }
}

function retryDelayMilliseconds(attempt: number): number {
  return Math.min(30 * 2 ** Math.min(attempt - 1, 10), 43_200) * 1000;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return message.slice(0, 500);
}
