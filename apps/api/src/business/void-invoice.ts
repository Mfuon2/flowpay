import { hashCanonicalJson } from "../flowpay/canonical-json.ts";
import { auditStatement } from "../flowpay/evidence-statements.ts";

export type VoidInvoiceCommand = Readonly<{
  commandId: string;
  organisationId: string;
  invoiceId: string;
  actorId: string;
  correlationId: string;
  reason: string;
  occurredAt: string;
}>;

type Existing = Readonly<{
  invoice_id: string;
  command_fingerprint: string;
}>;

export class InvoiceVoidConflictError extends Error {
  override readonly name = "InvoiceVoidConflictError";
}

export class InvoiceVoidUnavailableError extends Error {
  override readonly name = "InvoiceVoidUnavailableError";
}

export async function voidInvoice(
  database: D1Database,
  command: VoidInvoiceCommand,
): Promise<Readonly<{ invoiceId: string; status: "VOID"; replayed: boolean }>> {
  const normalized = {
    commandId: required("Command ID", command.commandId),
    organisationId: required("Organisation ID", command.organisationId),
    invoiceId: required("Invoice ID", command.invoiceId),
    actorId: required("Actor ID", command.actorId),
    correlationId: required("Correlation ID", command.correlationId),
    reason: required("Void reason", command.reason),
    occurredAt: timestamp(command.occurredAt),
  };
  const fingerprint = await hashCanonicalJson(normalized);
  const existing = await findExisting(database, normalized.commandId);
  if (existing) return replay(existing, normalized, fingerprint);
  const invoice = await database
    .prepare(
      `SELECT i.status,
              (SELECT COUNT(*) FROM payments p WHERE p.invoice_id = i.id) AS payment_count
       FROM invoices i WHERE i.id = ? AND i.organisation_id = ?`,
    )
    .bind(normalized.invoiceId, normalized.organisationId)
    .first<{ status: string; payment_count: number }>();
  if (!invoice || (invoice.status !== "DRAFT" && invoice.status !== "ISSUED")) {
    throw new InvoiceVoidUnavailableError(
      "Only a draft or issued invoice can be voided.",
    );
  }
  if (invoice.payment_count > 0) {
    throw new InvoiceVoidUnavailableError(
      "Resolve recorded payments before voiding this invoice.",
    );
  }
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO invoice_state_transitions (
            id, organisation_id, invoice_id, from_status, to_status, action,
            actor_id, reason, correlation_id, command_fingerprint, occurred_at
          ) VALUES (?, ?, ?, ?, 'VOID', 'VOID', ?, ?, ?, ?, ?)`,
        )
        .bind(
          normalized.commandId,
          normalized.organisationId,
          normalized.invoiceId,
          invoice.status,
          normalized.actorId,
          normalized.reason,
          normalized.correlationId,
          fingerprint,
          normalized.occurredAt,
        ),
      database
        .prepare(
          `UPDATE invoices SET status = 'VOID', updated_at = ?
           WHERE id = ? AND organisation_id = ? AND status = ?`,
        )
        .bind(
          normalized.occurredAt,
          normalized.invoiceId,
          normalized.organisationId,
          invoice.status,
        ),
      auditStatement(database, {
        id: crypto.randomUUID(),
        organisationId: normalized.organisationId,
        actorType: "USER",
        actorId: normalized.actorId,
        action: "INVOICE_VOIDED",
        aggregateType: "INVOICE",
        aggregateId: normalized.invoiceId,
        correlationId: normalized.correlationId,
        causationId: normalized.commandId,
        evidence: { fromStatus: invoice.status, reason: normalized.reason },
        occurredAt: normalized.occurredAt,
      }),
    ]);
  } catch (error) {
    const raced = await findExisting(database, normalized.commandId);
    if (raced) return replay(raced, normalized, fingerprint);
    throw error;
  }
  return { invoiceId: normalized.invoiceId, status: "VOID", replayed: false };
}

async function findExisting(
  database: D1Database,
  id: string,
): Promise<Existing | null> {
  return database
    .prepare(
      "SELECT invoice_id, command_fingerprint FROM invoice_state_transitions WHERE id = ?",
    )
    .bind(id)
    .first<Existing>();
}

function replay(
  existing: Existing,
  command: VoidInvoiceCommand,
  fingerprint: string,
) {
  if (
    existing.invoice_id !== command.invoiceId ||
    existing.command_fingerprint !== fingerprint
  ) {
    throw new InvoiceVoidConflictError(
      "The invoice-void command identity was used for different evidence.",
    );
  }
  return {
    invoiceId: command.invoiceId,
    status: "VOID" as const,
    replayed: true,
  };
}

function required(label: string, value: string): string {
  const result = value.trim();
  if (!result) throw new TypeError(`${label} is required.`);
  if (result.length > 500) throw new TypeError(`${label} is too long.`);
  return result;
}

function timestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError("Invoice void time must be ISO 8601.");
  }
  return value;
}
