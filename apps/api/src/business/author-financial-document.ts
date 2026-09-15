import { createMoney, serializeMoney, type JsonValue } from "@flowpay/domain";

import { canonicalJson, hashCanonicalJson } from "../flowpay/canonical-json.ts";
import {
  auditStatement,
  outboxStatement,
} from "../flowpay/evidence-statements.ts";
import { BusinessCommandConflictError } from "./create-party.ts";

type Context = Readonly<{
  commandId: string;
  organisationId: string;
  actorId: string;
  correlationId: string;
}>;

export type IssueInvoiceCommand = Context &
  Readonly<{
    customerId: string;
    jobId?: string;
    reference: string;
    assetCode: string;
    totalAtomic: string;
    assetScale: number;
    issuedAt: string;
    dueAt?: string;
  }>;

export type RecordPendingPaymentCommand = Context &
  Readonly<{
    invoiceId: string;
    externalReference: string;
    amountAtomic: string;
    receivedAt: string;
  }>;

type AuthoringResult = Readonly<{
  id: string;
  organisationId: string;
  status: "ISSUED" | "PENDING";
  assetCode: string;
  amountAtomic: string;
  assetScale: number;
  replayed: boolean;
}>;

type Receipt = Readonly<{
  command_type: string;
  command_fingerprint: string;
  result_json: string;
}>;

export class FinancialDocumentUnavailableError extends Error {
  override readonly name = "FinancialDocumentUnavailableError";
}

export async function issueInvoice(
  database: D1Database,
  command: IssueInvoiceCommand,
): Promise<AuthoringResult> {
  const money = serializeMoney(
    createMoney(command.assetCode, command.totalAtomic, command.assetScale),
  );
  if (BigInt(money.atomicAmount) === 0n) {
    throw new TypeError("Invoice total must be greater than zero.");
  }
  const normalized = {
    ...normalizeContext(command),
    customerId: required("Customer ID", command.customerId),
    ...(optional("Job ID", command.jobId) === undefined
      ? {}
      : { jobId: optional("Job ID", command.jobId) }),
    reference: required("Invoice reference", command.reference),
    ...money,
    issuedAt: timestamp("Invoice issue time", command.issuedAt),
    ...(optionalTimestamp("Invoice due time", command.dueAt) === undefined
      ? {}
      : { dueAt: optionalTimestamp("Invoice due time", command.dueAt) }),
  };
  if (normalized.dueAt && normalized.dueAt < normalized.issuedAt) {
    throw new TypeError("Invoice due time cannot precede its issue time.");
  }
  const commandType = "ISSUE_INVOICE";
  const fingerprint = await hashCanonicalJson({ commandType, ...normalized });
  const existing = await receipt(database, normalized.commandId);
  if (existing) return replay(existing, commandType, fingerprint);
  const references = await database
    .prepare(
      `SELECT c.id AS customer_id, j.id AS job_id, j.customer_id AS job_customer_id
       FROM customers c
       LEFT JOIN jobs j ON j.id = ? AND j.organisation_id = c.organisation_id
       WHERE c.id = ? AND c.organisation_id = ? AND c.status = 'ACTIVE'`,
    )
    .bind(
      normalized.jobId ?? null,
      normalized.customerId,
      normalized.organisationId,
    )
    .first<{
      customer_id: string;
      job_id: string | null;
      job_customer_id: string | null;
    }>();
  if (!references) {
    throw new FinancialDocumentUnavailableError(
      "The invoice requires an active customer in this organisation.",
    );
  }
  if (
    normalized.jobId &&
    (!references.job_id || references.job_customer_id !== normalized.customerId)
  ) {
    throw new FinancialDocumentUnavailableError(
      "The selected job must belong to the invoice customer and organisation.",
    );
  }
  const id = `invoice:${crypto.randomUUID()}`;
  const result: AuthoringResult = {
    id,
    organisationId: normalized.organisationId,
    status: "ISSUED",
    assetCode: money.assetCode,
    amountAtomic: money.atomicAmount,
    assetScale: money.scale,
    replayed: false,
  };
  return executeAuthoring(database, {
    commandType,
    fingerprint,
    context: normalized,
    aggregateType: "INVOICE",
    aggregateId: id,
    result,
    occurredAt: normalized.issuedAt,
    record: database
      .prepare(
        `INSERT INTO invoices (
          id, organisation_id, customer_id, job_id, reference, status,
          asset_code, total_atomic, asset_scale, issued_at, due_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'ISSUED', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        normalized.organisationId,
        normalized.customerId,
        normalized.jobId ?? null,
        normalized.reference,
        money.assetCode,
        money.atomicAmount,
        money.scale,
        normalized.issuedAt,
        normalized.dueAt ?? null,
        normalized.issuedAt,
        normalized.issuedAt,
      ),
    evidence: {
      customerId: normalized.customerId,
      jobId: normalized.jobId ?? null,
      reference: normalized.reference,
      total: money,
    },
  });
}

export async function recordPendingPayment(
  database: D1Database,
  command: RecordPendingPaymentCommand,
): Promise<AuthoringResult> {
  const normalizedInput = {
    ...normalizeContext(command),
    invoiceId: required("Invoice ID", command.invoiceId),
    externalReference: required("Payment reference", command.externalReference),
    amountAtomic: required("Payment amount", command.amountAtomic),
    receivedAt: timestamp("Payment received time", command.receivedAt),
  };
  const commandType = "RECORD_PENDING_PAYMENT";
  const fingerprint = await hashCanonicalJson({
    commandType,
    ...normalizedInput,
  });
  const existing = await receipt(database, normalizedInput.commandId);
  if (existing) return replay(existing, commandType, fingerprint);
  const invoice = await database
    .prepare(
      `SELECT asset_code, total_atomic, asset_scale, status
       FROM invoices WHERE id = ? AND organisation_id = ?`,
    )
    .bind(normalizedInput.invoiceId, normalizedInput.organisationId)
    .first<{
      asset_code: string;
      total_atomic: string;
      asset_scale: number;
      status: string;
    }>();
  if (!invoice || invoice.status !== "ISSUED") {
    throw new FinancialDocumentUnavailableError(
      "A pending payment requires an issued invoice in this organisation.",
    );
  }
  const money = serializeMoney(
    createMoney(
      invoice.asset_code,
      normalizedInput.amountAtomic,
      invoice.asset_scale,
    ),
  );
  if (
    BigInt(money.atomicAmount) === 0n ||
    money.atomicAmount !== invoice.total_atomic
  ) {
    throw new TypeError(
      "The MVP records one full payment equal to the invoice total; partial receipts are not yet supported.",
    );
  }
  const normalized = {
    ...normalizedInput,
    ...money,
  };
  const id = `payment:${crypto.randomUUID()}`;
  const result: AuthoringResult = {
    id,
    organisationId: normalized.organisationId,
    status: "PENDING",
    assetCode: money.assetCode,
    amountAtomic: money.atomicAmount,
    assetScale: money.scale,
    replayed: false,
  };
  return executeAuthoring(database, {
    commandType,
    fingerprint,
    context: normalized,
    aggregateType: "PAYMENT",
    aggregateId: id,
    result,
    occurredAt: normalized.receivedAt,
    record: database
      .prepare(
        `INSERT INTO payments (
          id, organisation_id, invoice_id, external_reference, status,
          asset_code, amount_atomic, asset_scale, received_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        normalized.organisationId,
        normalized.invoiceId,
        normalized.externalReference,
        money.assetCode,
        money.atomicAmount,
        money.scale,
        normalized.receivedAt,
        normalized.receivedAt,
        normalized.receivedAt,
      ),
    evidence: {
      invoiceId: normalized.invoiceId,
      externalReference: normalized.externalReference,
      amount: money,
    },
  });
}

async function executeAuthoring(
  database: D1Database,
  input: Readonly<{
    commandType: string;
    fingerprint: string;
    context: Context;
    aggregateType: "INVOICE" | "PAYMENT";
    aggregateId: string;
    result: AuthoringResult;
    occurredAt: string;
    record: D1PreparedStatement;
    evidence: JsonValue;
  }>,
): Promise<AuthoringResult> {
  const outbox =
    input.aggregateType === "INVOICE"
      ? [
          outboxStatement(database, {
            id: `outbox:${input.context.commandId}:invoice-issued`,
            organisationId: input.context.organisationId,
            messageType: "BUSINESS_INVOICE_ISSUED",
            aggregateType: "INVOICE",
            aggregateId: input.aggregateId,
            correlationId: input.context.correlationId,
            causationId: input.context.commandId,
            payload: { invoiceId: input.aggregateId },
            createdAt: input.occurredAt,
          }),
        ]
      : [];
  try {
    await database.batch([
      input.record,
      auditStatement(database, {
        id: crypto.randomUUID(),
        organisationId: input.context.organisationId,
        actorType: "USER",
        actorId: input.context.actorId,
        action:
          input.aggregateType === "INVOICE"
            ? "INVOICE_ISSUED"
            : "PAYMENT_RECORDED",
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        correlationId: input.context.correlationId,
        causationId: input.context.commandId,
        evidence: input.evidence,
        occurredAt: input.occurredAt,
      }),
      ...outbox,
      database
        .prepare(
          `INSERT INTO application_command_receipts (
            id, organisation_id, command_type, command_fingerprint,
            aggregate_type, aggregate_id, result_json, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.context.commandId,
          input.context.organisationId,
          input.commandType,
          input.fingerprint,
          input.aggregateType,
          input.aggregateId,
          canonicalJson(input.result),
          input.occurredAt,
        ),
    ]);
    return input.result;
  } catch (error) {
    const raced = await receipt(database, input.context.commandId);
    if (raced) {
      return replay(raced, input.commandType, input.fingerprint);
    }
    throw error;
  }
}

async function receipt(
  database: D1Database,
  id: string,
): Promise<Receipt | null> {
  return database
    .prepare(
      `SELECT command_type, command_fingerprint, result_json
       FROM application_command_receipts WHERE id = ?`,
    )
    .bind(id)
    .first<Receipt>();
}

function replay(
  existing: Receipt,
  commandType: string,
  fingerprint: string,
): AuthoringResult {
  if (
    existing.command_type !== commandType ||
    existing.command_fingerprint !== fingerprint
  ) {
    throw new BusinessCommandConflictError(
      "The command identity was already used for different financial data.",
    );
  }
  const result = JSON.parse(existing.result_json) as AuthoringResult;
  return { ...result, replayed: true };
}

function normalizeContext(command: Context): Context {
  return {
    commandId: required("Command ID", command.commandId),
    organisationId: required("Organisation ID", command.organisationId),
    actorId: required("Actor ID", command.actorId),
    correlationId: required("Correlation ID", command.correlationId),
  };
}

function required(label: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} is required.`);
  if (normalized.length > 160) throw new TypeError(`${label} is too long.`);
  return normalized;
}

function optional(label: string, value?: string): string | undefined {
  return value === undefined ? undefined : required(label, value);
}

function timestamp(label: string, value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${label} must be an ISO 8601 UTC timestamp.`);
  }
  return value;
}

function optionalTimestamp(label: string, value?: string): string | undefined {
  return value === undefined ? undefined : timestamp(label, value);
}
