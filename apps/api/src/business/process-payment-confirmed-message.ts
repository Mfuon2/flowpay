import { recordBusinessEvent } from "../flowpay/process-business-event.ts";
import type { FlowPayQueueMessage } from "../messaging/outbox.ts";

export class PaymentEventAdapterError extends Error {
  override readonly name = "PaymentEventAdapterError";
}

type PaymentFacts = Readonly<{
  payment_id: string;
  payment_status: string;
  confirmed_at: string | null;
  asset_code: string;
  amount_atomic: string;
  asset_scale: number;
  invoice_id: string;
  invoice_status: string;
  job_id: string | null;
  job_status: string | null;
}>;

export async function processPaymentConfirmedMessage(
  database: D1Database,
  message: FlowPayQueueMessage,
) {
  if (message.messageType !== "BUSINESS_PAYMENT_CONFIRMED") {
    throw new PaymentEventAdapterError(
      "Payment adapter received an unsupported message type.",
    );
  }
  const paymentId = paymentIdFromPayload(message.payloadJson);
  if (paymentId !== message.aggregateId) {
    throw new PaymentEventAdapterError(
      "Payment message payload and aggregate identities differ.",
    );
  }
  const facts = await database
    .prepare(
      `SELECT p.id AS payment_id, p.status AS payment_status, p.confirmed_at,
              p.asset_code, p.amount_atomic, p.asset_scale,
              i.id AS invoice_id, i.status AS invoice_status,
              j.id AS job_id, j.status AS job_status
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id
       LEFT JOIN jobs j ON j.id = i.job_id
       WHERE p.id = ? AND p.organisation_id = ?
         AND i.organisation_id = ?`,
    )
    .bind(paymentId, message.organisationId, message.organisationId)
    .first<PaymentFacts>();
  if (!facts || facts.payment_status !== "CONFIRMED" || !facts.confirmed_at) {
    throw new PaymentEventAdapterError(
      "Confirmed payment facts were not found in the organisation.",
    );
  }
  return recordBusinessEvent(database, {
    event: {
      id: `event:${message.messageId}`,
      organisationId: message.organisationId,
      source: "qesuite.sales",
      externalEventId: message.messageId,
      eventType: "PAYMENT_CONFIRMED",
      schemaVersion: 1,
      aggregateType: "PAYMENT",
      aggregateId: facts.payment_id,
      occurredAt: facts.confirmed_at,
      recordedAt: new Date().toISOString(),
      correlationId: message.correlationId,
      causationId: message.messageId,
      payload: {
        paymentId: facts.payment_id,
        invoiceId: facts.invoice_id,
        jobId: facts.job_id,
        amount: {
          assetCode: facts.asset_code,
          atomicAmount: facts.amount_atomic,
          scale: facts.asset_scale,
        },
      },
    },
    facts: {
      "payment.amount": {
        assetCode: facts.asset_code,
        atomicAmount: facts.amount_atomic,
        scale: facts.asset_scale,
      },
      "payment.status": facts.payment_status,
      "invoice.status": facts.invoice_status,
      ...(facts.job_status === null ? {} : { "job.status": facts.job_status }),
    },
    settlementAmount: {
      assetCode: facts.asset_code,
      atomicAmount: facts.amount_atomic,
      scale: facts.asset_scale,
    },
    initiatedBy: "payment-confirmed-adapter",
  });
}

function paymentIdFromPayload(payloadJson: string): string {
  let value: unknown;
  try {
    value = JSON.parse(payloadJson) as unknown;
  } catch {
    throw new PaymentEventAdapterError(
      "Payment-confirmed message payload is invalid JSON.",
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("paymentId" in value) ||
    typeof value.paymentId !== "string" ||
    value.paymentId.length === 0
  ) {
    throw new PaymentEventAdapterError(
      "Payment-confirmed message has no payment identity.",
    );
  }
  return value.paymentId;
}
