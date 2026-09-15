import { recordBusinessEvent } from "../flowpay/process-business-event.ts";
import type { FlowPayQueueMessage } from "../messaging/outbox.ts";

export class QuoteEventAdapterError extends Error {
  override readonly name = "QuoteEventAdapterError";
}

type QuoteFacts = Readonly<{
  quote_id: string;
  quote_status: string;
  approved_at: string | null;
  asset_code: string;
  total_atomic: string;
  asset_scale: number;
  customer_id: string;
  job_id: string | null;
  job_status: string | null;
}>;

export async function processQuoteApprovedMessage(
  database: D1Database,
  message: FlowPayQueueMessage,
) {
  if (message.messageType !== "BUSINESS_QUOTE_APPROVED") {
    throw new QuoteEventAdapterError(
      "Quote adapter received an unsupported message type.",
    );
  }
  const quoteId = quoteIdFromPayload(message.payloadJson);
  if (quoteId !== message.aggregateId) {
    throw new QuoteEventAdapterError(
      "Quote message payload and aggregate identities differ.",
    );
  }
  const facts = await database
    .prepare(
      `SELECT q.id AS quote_id, q.status AS quote_status, q.approved_at,
              q.asset_code, q.total_atomic, q.asset_scale, q.customer_id,
              q.job_id, j.status AS job_status
       FROM quotes q LEFT JOIN jobs j ON j.id = q.job_id
       WHERE q.id = ? AND q.organisation_id = ?`,
    )
    .bind(quoteId, message.organisationId)
    .first<QuoteFacts>();
  if (!facts || facts.quote_status !== "APPROVED" || !facts.approved_at) {
    throw new QuoteEventAdapterError(
      "Approved quote facts were not found in the organisation.",
    );
  }
  return recordBusinessEvent(database, {
    event: {
      id: `event:${message.messageId}`,
      organisationId: message.organisationId,
      source: "qesuite.sales",
      externalEventId: message.messageId,
      eventType: "QUOTE_APPROVED",
      schemaVersion: 1,
      aggregateType: "QUOTE",
      aggregateId: facts.quote_id,
      occurredAt: facts.approved_at,
      recordedAt: new Date().toISOString(),
      correlationId: message.correlationId,
      causationId: message.messageId,
      payload: {
        quoteId: facts.quote_id,
        customerId: facts.customer_id,
        jobId: facts.job_id,
        amount: {
          assetCode: facts.asset_code,
          atomicAmount: facts.total_atomic,
          scale: facts.asset_scale,
        },
      },
    },
    facts: {
      "quote.status": facts.quote_status,
      ...(facts.job_status === null ? {} : { "job.status": facts.job_status }),
    },
    settlementAmount: {
      assetCode: facts.asset_code,
      atomicAmount: facts.total_atomic,
      scale: facts.asset_scale,
    },
    initiatedBy: "quote-approved-adapter",
  });
}

function quoteIdFromPayload(payloadJson: string): string {
  let value: unknown;
  try {
    value = JSON.parse(payloadJson) as unknown;
  } catch {
    throw new QuoteEventAdapterError(
      "Quote-approved message payload is invalid JSON.",
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("quoteId" in value) ||
    typeof value.quoteId !== "string" ||
    !value.quoteId
  ) {
    throw new QuoteEventAdapterError(
      "Quote-approved message has no quote identity.",
    );
  }
  return value.quoteId;
}
