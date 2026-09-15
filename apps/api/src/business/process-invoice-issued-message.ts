import { recordBusinessEvent } from "../flowpay/process-business-event.ts";
import type { FlowPayQueueMessage } from "../messaging/outbox.ts";

export class InvoiceEventAdapterError extends Error {
  override readonly name = "InvoiceEventAdapterError";
}

type InvoiceFacts = Readonly<{
  invoice_id: string;
  invoice_status: string;
  issued_at: string;
  asset_code: string;
  total_atomic: string;
  asset_scale: number;
  customer_id: string;
  job_id: string | null;
  job_status: string | null;
}>;

export async function processInvoiceIssuedMessage(
  database: D1Database,
  message: FlowPayQueueMessage,
) {
  if (message.messageType !== "BUSINESS_INVOICE_ISSUED") {
    throw new InvoiceEventAdapterError(
      "Invoice adapter received an unsupported message type.",
    );
  }
  const invoiceId = invoiceIdFromPayload(message.payloadJson);
  if (invoiceId !== message.aggregateId) {
    throw new InvoiceEventAdapterError(
      "Invoice message payload and aggregate identities differ.",
    );
  }
  const facts = await database
    .prepare(
      `SELECT i.id AS invoice_id, i.status AS invoice_status, i.issued_at,
              i.asset_code, i.total_atomic, i.asset_scale, i.customer_id,
              i.job_id, j.status AS job_status
       FROM invoices i LEFT JOIN jobs j ON j.id = i.job_id
       WHERE i.id = ? AND i.organisation_id = ?`,
    )
    .bind(invoiceId, message.organisationId)
    .first<InvoiceFacts>();
  if (
    !facts ||
    (facts.invoice_status !== "ISSUED" && facts.invoice_status !== "PAID")
  ) {
    throw new InvoiceEventAdapterError(
      "Issued invoice facts were not found in the organisation.",
    );
  }
  return recordBusinessEvent(database, {
    event: {
      id: `event:${message.messageId}`,
      organisationId: message.organisationId,
      source: "qesuite.sales",
      externalEventId: message.messageId,
      eventType: "INVOICE_ISSUED",
      schemaVersion: 1,
      aggregateType: "INVOICE",
      aggregateId: facts.invoice_id,
      occurredAt: facts.issued_at,
      recordedAt: new Date().toISOString(),
      correlationId: message.correlationId,
      causationId: message.messageId,
      payload: {
        invoiceId: facts.invoice_id,
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
      "invoice.status": "ISSUED",
      ...(facts.job_status === null ? {} : { "job.status": facts.job_status }),
    },
    settlementAmount: {
      assetCode: facts.asset_code,
      atomicAmount: facts.total_atomic,
      scale: facts.asset_scale,
    },
    initiatedBy: "invoice-issued-adapter",
  });
}

function invoiceIdFromPayload(payloadJson: string): string {
  let value: unknown;
  try {
    value = JSON.parse(payloadJson) as unknown;
  } catch {
    throw new InvoiceEventAdapterError(
      "Invoice-issued message payload is invalid JSON.",
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("invoiceId" in value) ||
    typeof value.invoiceId !== "string" ||
    !value.invoiceId
  ) {
    throw new InvoiceEventAdapterError(
      "Invoice-issued message has no invoice identity.",
    );
  }
  return value.invoiceId;
}
