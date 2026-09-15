import { hashCanonicalJson } from "../flowpay/canonical-json.ts";
import {
  auditStatement,
  outboxStatement,
} from "../flowpay/evidence-statements.ts";

export type ConfirmPaymentCommand = Readonly<{
  commandId: string;
  organisationId: string;
  paymentId: string;
  actorId: string;
  correlationId: string;
  confirmedAt: string;
}>;

export type ConfirmPaymentResult = Readonly<{
  paymentId: string;
  status: "CONFIRMED";
  invoiceStatus: "ISSUED" | "PAID";
  replayed: boolean;
}>;

export class PaymentConfirmationConflictError extends Error {
  override readonly name = "PaymentConfirmationConflictError";
}

export class PaymentConfirmationUnavailableError extends Error {
  override readonly name = "PaymentConfirmationUnavailableError";
}

type PaymentContext = Readonly<{
  payment_status: string;
  payment_asset_code: string;
  payment_amount_atomic: string;
  payment_asset_scale: number;
  invoice_id: string;
  invoice_status: "ISSUED" | "PAID";
  invoice_asset_code: string;
  invoice_total_atomic: string;
  invoice_asset_scale: number;
}>;

type ExistingTransition = Readonly<{
  payment_id: string;
  command_fingerprint: string;
}>;

export async function confirmPayment(
  database: D1Database,
  command: ConfirmPaymentCommand,
): Promise<ConfirmPaymentResult> {
  validateCommand(command);
  const fingerprint = await hashCanonicalJson(command);
  const existing = await findExisting(database, command.commandId);
  if (existing) return replay(database, command, fingerprint, existing);

  const context = await loadContext(database, command);
  if (context.payment_status !== "PENDING") {
    throw new PaymentConfirmationUnavailableError(
      "Only a pending payment can be confirmed.",
    );
  }
  if (context.invoice_status !== "ISSUED") {
    throw new PaymentConfirmationUnavailableError(
      "The payment invoice is not open for confirmation.",
    );
  }
  if (
    context.payment_asset_code !== context.invoice_asset_code ||
    context.payment_asset_scale !== context.invoice_asset_scale
  ) {
    throw new PaymentConfirmationUnavailableError(
      "Payment and invoice asset precision do not match.",
    );
  }
  if (
    BigInt(context.payment_amount_atomic) > BigInt(context.invoice_total_atomic)
  ) {
    throw new PaymentConfirmationUnavailableError(
      "Payment amount cannot exceed the invoice total.",
    );
  }
  const invoicePaid =
    context.payment_amount_atomic === context.invoice_total_atomic;
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `INSERT INTO payment_state_transitions (
          id, organisation_id, payment_id, from_status, to_status,
          actor_id, correlation_id, command_fingerprint, occurred_at
        ) VALUES (?, ?, ?, 'PENDING', 'CONFIRMED', ?, ?, ?, ?)`,
      )
      .bind(
        command.commandId,
        command.organisationId,
        command.paymentId,
        command.actorId,
        command.correlationId,
        fingerprint,
        command.confirmedAt,
      ),
    database
      .prepare(
        `UPDATE payments
         SET status = 'CONFIRMED', confirmed_at = ?, updated_at = ?
         WHERE id = ? AND organisation_id = ? AND status = 'PENDING'`,
      )
      .bind(
        command.confirmedAt,
        command.confirmedAt,
        command.paymentId,
        command.organisationId,
      ),
  ];
  if (invoicePaid) {
    statements.push(
      database
        .prepare(
          `INSERT INTO invoice_state_transitions (
            id, organisation_id, invoice_id, from_status, to_status, action,
            actor_id, correlation_id, command_fingerprint, occurred_at
          ) VALUES (?, ?, ?, 'ISSUED', 'PAID', 'PAYMENT_RECEIVED', ?, ?, ?, ?)`,
        )
        .bind(
          `invoice:${command.commandId}`,
          command.organisationId,
          context.invoice_id,
          command.actorId,
          command.correlationId,
          fingerprint,
          command.confirmedAt,
        ),
      database
        .prepare(
          `UPDATE invoices SET status = 'PAID', paid_at = ?, updated_at = ?
           WHERE id = ? AND organisation_id = ? AND status = 'ISSUED'`,
        )
        .bind(
          command.confirmedAt,
          command.confirmedAt,
          context.invoice_id,
          command.organisationId,
        ),
    );
  }
  statements.push(
    auditStatement(database, {
      id: crypto.randomUUID(),
      organisationId: command.organisationId,
      actorType: "USER",
      actorId: command.actorId,
      action: "PAYMENT_CONFIRMED",
      aggregateType: "PAYMENT",
      aggregateId: command.paymentId,
      correlationId: command.correlationId,
      causationId: command.commandId,
      evidence: {
        invoiceId: context.invoice_id,
        amount: {
          assetCode: context.payment_asset_code,
          atomicAmount: context.payment_amount_atomic,
          scale: context.payment_asset_scale,
        },
        invoicePaid,
      },
      occurredAt: command.confirmedAt,
    }),
    outboxStatement(database, {
      id: crypto.randomUUID(),
      organisationId: command.organisationId,
      messageType: "BUSINESS_PAYMENT_CONFIRMED",
      aggregateType: "PAYMENT",
      aggregateId: command.paymentId,
      correlationId: command.correlationId,
      causationId: command.commandId,
      payload: {
        paymentId: command.paymentId,
        invoiceId: context.invoice_id,
      },
      createdAt: command.confirmedAt,
    }),
  );
  try {
    await database.batch(statements);
  } catch (error) {
    const concurrent = await findExisting(database, command.commandId);
    if (concurrent) {
      return replay(database, command, fingerprint, concurrent);
    }
    throw error;
  }
  return {
    paymentId: command.paymentId,
    status: "CONFIRMED",
    invoiceStatus: invoicePaid ? "PAID" : "ISSUED",
    replayed: false,
  };
}

async function loadContext(
  database: D1Database,
  command: Pick<ConfirmPaymentCommand, "organisationId" | "paymentId">,
): Promise<PaymentContext> {
  const context = await database
    .prepare(
      `SELECT p.status AS payment_status,
              p.asset_code AS payment_asset_code,
              p.amount_atomic AS payment_amount_atomic,
              p.asset_scale AS payment_asset_scale,
              i.id AS invoice_id, i.status AS invoice_status,
              i.asset_code AS invoice_asset_code,
              i.total_atomic AS invoice_total_atomic,
              i.asset_scale AS invoice_asset_scale
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id
       WHERE p.id = ? AND p.organisation_id = ?
         AND i.organisation_id = ?`,
    )
    .bind(command.paymentId, command.organisationId, command.organisationId)
    .first<PaymentContext>();
  if (!context) {
    throw new PaymentConfirmationUnavailableError(
      "Payment was not found in the organisation.",
    );
  }
  return context;
}

async function findExisting(
  database: D1Database,
  commandId: string,
): Promise<ExistingTransition | null> {
  return database
    .prepare(
      `SELECT payment_id, command_fingerprint
       FROM payment_state_transitions WHERE id = ?`,
    )
    .bind(commandId)
    .first<ExistingTransition>();
}

async function replay(
  database: D1Database,
  command: ConfirmPaymentCommand,
  fingerprint: string,
  existing: ExistingTransition,
): Promise<ConfirmPaymentResult> {
  if (
    existing.payment_id !== command.paymentId ||
    existing.command_fingerprint !== fingerprint
  ) {
    throw new PaymentConfirmationConflictError(
      "The payment-confirmation command identity was used for different data.",
    );
  }
  const context = await loadContext(database, command);
  return {
    paymentId: command.paymentId,
    status: "CONFIRMED",
    invoiceStatus: context.invoice_status,
    replayed: true,
  };
}

function validateCommand(command: ConfirmPaymentCommand): void {
  for (const [label, value] of [
    ["Command ID", command.commandId],
    ["Organisation ID", command.organisationId],
    ["Payment ID", command.paymentId],
    ["Actor ID", command.actorId],
    ["Correlation ID", command.correlationId],
  ] as const) {
    if (value.length === 0 || value !== value.trim()) {
      throw new TypeError(`${label} must be a trimmed value.`);
    }
  }
  if (
    !Number.isFinite(Date.parse(command.confirmedAt)) ||
    !command.confirmedAt.endsWith("Z")
  ) {
    throw new TypeError("Confirmation time must be a UTC timestamp.");
  }
}
