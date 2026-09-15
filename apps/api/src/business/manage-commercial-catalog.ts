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

export type CreateServiceCommand = Context &
  Readonly<{
    name: string;
    description?: string;
    assetCode: string;
    unitPriceAtomic: string;
    assetScale: number;
  }>;

export type CreateQuoteCommand = Context &
  Readonly<{
    customerId: string;
    jobId?: string;
    reference: string;
    assetCode: string;
    assetScale: number;
    lines: readonly Readonly<{
      serviceId?: string;
      description: string;
      quantityAtomic: string;
      quantityScale: number;
      unitPriceAtomic: string;
    }>[];
  }>;

export type TransitionQuoteCommand = Context &
  Readonly<{
    quoteId: string;
    action: "ISSUE" | "APPROVE" | "REJECT" | "EXPIRE";
    reason?: string;
    occurredAt: string;
  }>;

export class CommercialRecordUnavailableError extends Error {
  override readonly name = "CommercialRecordUnavailableError";
}

type Receipt = Readonly<{
  command_type: string;
  command_fingerprint: string;
  result_json: string;
}>;

type CommandResult = Readonly<{
  id: string;
  organisationId: string;
  status: string;
  replayed: boolean;
}>;

export async function createService(
  database: D1Database,
  command: CreateServiceCommand,
): Promise<CommandResult> {
  const money = serializeMoney(
    createMoney(command.assetCode, command.unitPriceAtomic, command.assetScale),
  );
  const normalized = {
    ...context(command),
    name: required("Service name", command.name),
    ...(optional(command.description)
      ? { description: optional(command.description) }
      : {}),
    ...money,
  };
  const commandType = "CREATE_SERVICE";
  const fingerprint = await hashCanonicalJson({ commandType, ...normalized });
  const existing = await receipt(database, normalized.commandId);
  if (existing) return replay(existing, commandType, fingerprint);
  const id = `service:${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const result = {
    id,
    organisationId: normalized.organisationId,
    status: "ACTIVE",
    replayed: false,
  } as const;
  return writeCommand(database, {
    context: normalized,
    commandType,
    fingerprint,
    aggregateType: "SERVICE",
    aggregateId: id,
    result,
    occurredAt: now,
    statements: [
      database
        .prepare(
          `INSERT INTO services (
            id, organisation_id, name, description, unit_price_atomic,
            asset_code, asset_scale, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
        )
        .bind(
          id,
          normalized.organisationId,
          normalized.name,
          normalized.description ?? null,
          normalized.atomicAmount,
          normalized.assetCode,
          normalized.scale,
          now,
          now,
        ),
    ],
    evidence: { name: normalized.name, unitPrice: money },
  });
}

export async function createQuote(
  database: D1Database,
  command: CreateQuoteCommand,
): Promise<
  CommandResult & { totalAtomic: string; assetCode: string; assetScale: number }
> {
  const normalizedContext = context(command);
  const customerId = required("Customer ID", command.customerId);
  const jobId = optional(command.jobId);
  const reference = required("Quote reference", command.reference);
  if (!command.lines.length)
    throw new TypeError("A quote requires at least one line.");
  const asset = serializeMoney(
    createMoney(command.assetCode, "0", command.assetScale),
  );
  const lines = command.lines.map((line, position) => {
    const quantityAtomic = positiveInteger(
      "Quote quantity",
      line.quantityAtomic,
    );
    if (
      !Number.isSafeInteger(line.quantityScale) ||
      line.quantityScale < 0 ||
      line.quantityScale > 6
    ) {
      throw new TypeError(
        "Quote quantity scale must be from zero through six.",
      );
    }
    const price = serializeMoney(
      createMoney(asset.assetCode, line.unitPriceAtomic, asset.scale),
    );
    const divisor = 10n ** BigInt(line.quantityScale);
    const numerator = BigInt(quantityAtomic) * BigInt(price.atomicAmount);
    if (numerator % divisor !== 0n) {
      throw new TypeError(
        "Quote line total must be exact at the selected precision.",
      );
    }
    return {
      position,
      ...(optional(line.serviceId)
        ? { serviceId: optional(line.serviceId) }
        : {}),
      description: required("Quote line description", line.description),
      quantityAtomic,
      quantityScale: line.quantityScale,
      unitPriceAtomic: price.atomicAmount,
      lineTotalAtomic: (numerator / divisor).toString(),
    };
  });
  const totalAtomic = lines
    .reduce((sum, line) => sum + BigInt(line.lineTotalAtomic), 0n)
    .toString();
  if (totalAtomic === "0")
    throw new TypeError("Quote total must be greater than zero.");
  const normalized = {
    ...normalizedContext,
    customerId,
    ...(jobId ? { jobId } : {}),
    reference,
    assetCode: asset.assetCode,
    assetScale: asset.scale,
    totalAtomic,
    lines,
  };
  const commandType = "CREATE_QUOTE";
  const fingerprint = await hashCanonicalJson({ commandType, ...normalized });
  const existing = await receipt(database, normalized.commandId);
  if (existing)
    return replay<
      CommandResult & {
        totalAtomic: string;
        assetCode: string;
        assetScale: number;
      }
    >(existing, commandType, fingerprint);
  await validateQuoteReferences(
    database,
    normalized.organisationId,
    customerId,
    jobId,
    lines,
    asset.assetCode,
    asset.scale,
  );
  const id = `quote:${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const result = {
    id,
    organisationId: normalized.organisationId,
    status: "DRAFT",
    totalAtomic,
    assetCode: asset.assetCode,
    assetScale: asset.scale,
    replayed: false,
  } as const;
  return writeCommand(database, {
    context: normalized,
    commandType,
    fingerprint,
    aggregateType: "QUOTE",
    aggregateId: id,
    result,
    occurredAt: now,
    statements: [
      database
        .prepare(
          `INSERT INTO quotes (
            id, organisation_id, customer_id, job_id, reference, status,
            asset_code, total_atomic, asset_scale, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          normalized.organisationId,
          customerId,
          jobId ?? null,
          reference,
          asset.assetCode,
          totalAtomic,
          asset.scale,
          now,
          now,
        ),
      ...lines.map((line) =>
        database
          .prepare(
            `INSERT INTO quote_lines (
              id, quote_id, service_id, position, description,
              quantity_atomic, quantity_scale, unit_price_atomic, line_total_atomic
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            `quote-line:${crypto.randomUUID()}`,
            id,
            line.serviceId ?? null,
            line.position,
            line.description,
            line.quantityAtomic,
            line.quantityScale,
            line.unitPriceAtomic,
            line.lineTotalAtomic,
          ),
      ),
    ],
    evidence: {
      customerId,
      jobId: jobId ?? null,
      reference,
      total: {
        assetCode: asset.assetCode,
        atomicAmount: totalAtomic,
        scale: asset.scale,
      },
      lineCount: lines.length,
    },
  });
}

export async function transitionQuote(
  database: D1Database,
  command: TransitionQuoteCommand,
): Promise<CommandResult> {
  const normalized = {
    ...context(command),
    quoteId: required("Quote ID", command.quoteId),
    action: command.action,
    ...(optional(command.reason) ? { reason: optional(command.reason) } : {}),
    occurredAt: timestamp(command.occurredAt),
  };
  if (normalized.action === "REJECT" && !normalized.reason) {
    throw new TypeError("Quote rejection requires a reason.");
  }
  const commandType = `TRANSITION_QUOTE_${normalized.action}`;
  const fingerprint = await hashCanonicalJson({ commandType, ...normalized });
  const existing = await receipt(database, normalized.commandId);
  if (existing) return replay(existing, commandType, fingerprint);
  const quote = await database
    .prepare(
      "SELECT status, total_atomic FROM quotes WHERE id = ? AND organisation_id = ?",
    )
    .bind(normalized.quoteId, normalized.organisationId)
    .first<{ status: string; total_atomic: string }>();
  if (!quote)
    throw new CommercialRecordUnavailableError("Quote was not found.");
  if (normalized.action === "ISSUE") {
    const rows = await database
      .prepare(
        "SELECT line_total_atomic FROM quote_lines WHERE quote_id = ? ORDER BY position",
      )
      .bind(normalized.quoteId)
      .all<{ line_total_atomic: string }>();
    const lineTotal = rows.results.reduce(
      (sum, line) => sum + BigInt(line.line_total_atomic),
      0n,
    );
    if (
      rows.results.length === 0 ||
      lineTotal.toString() !== quote.total_atomic
    ) {
      throw new CommercialRecordUnavailableError(
        "Quote lines must exactly equal the quote total before issue.",
      );
    }
  }
  const toStatus = nextQuoteStatus(quote.status, normalized.action);
  const result = {
    id: normalized.quoteId,
    organisationId: normalized.organisationId,
    status: toStatus,
    replayed: false,
  } as const;
  const outbox =
    toStatus === "APPROVED"
      ? [
          outboxStatement(database, {
            id: `outbox:${normalized.commandId}:quote-approved`,
            organisationId: normalized.organisationId,
            messageType: "BUSINESS_QUOTE_APPROVED",
            aggregateType: "QUOTE",
            aggregateId: normalized.quoteId,
            correlationId: normalized.correlationId,
            causationId: normalized.commandId,
            payload: { quoteId: normalized.quoteId },
            createdAt: normalized.occurredAt,
          }),
        ]
      : [];
  return writeCommand(database, {
    context: normalized,
    commandType,
    fingerprint,
    aggregateType: "QUOTE",
    aggregateId: normalized.quoteId,
    result,
    occurredAt: normalized.occurredAt,
    statements: [
      database
        .prepare(
          `INSERT INTO quote_state_transitions (
          id, organisation_id, quote_id, from_status, to_status, action,
          actor_id, reason, correlation_id, command_fingerprint, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          normalized.commandId,
          normalized.organisationId,
          normalized.quoteId,
          quote.status,
          toStatus,
          normalized.action,
          normalized.actorId,
          normalized.reason ?? null,
          normalized.correlationId,
          fingerprint,
          normalized.occurredAt,
        ),
      database
        .prepare(
          `UPDATE quotes SET status = ?, issued_at = CASE WHEN ? = 'ISSUED' THEN ? ELSE issued_at END,
          approved_at = CASE WHEN ? = 'APPROVED' THEN ? ELSE approved_at END, updated_at = ?
         WHERE id = ? AND organisation_id = ? AND status = ?`,
        )
        .bind(
          toStatus,
          toStatus,
          normalized.occurredAt,
          toStatus,
          normalized.occurredAt,
          normalized.occurredAt,
          normalized.quoteId,
          normalized.organisationId,
          quote.status,
        ),
      ...outbox,
    ],
    evidence: {
      fromStatus: quote.status,
      toStatus,
      reason: normalized.reason ?? null,
    },
  });
}

async function validateQuoteReferences(
  database: D1Database,
  organisationId: string,
  customerId: string,
  jobId: string | undefined,
  lines: readonly { serviceId?: string }[],
  assetCode: string,
  assetScale: number,
) {
  const reference = await database
    .prepare(
      `SELECT c.id, j.id AS job_id, j.customer_id AS job_customer_id
     FROM customers c LEFT JOIN jobs j ON j.id = ? AND j.organisation_id = c.organisation_id
     WHERE c.id = ? AND c.organisation_id = ? AND c.status = 'ACTIVE'`,
    )
    .bind(jobId ?? null, customerId, organisationId)
    .first<{
      id: string;
      job_id: string | null;
      job_customer_id: string | null;
    }>();
  if (
    !reference ||
    (jobId &&
      (reference.job_id !== jobId || reference.job_customer_id !== customerId))
  ) {
    throw new CommercialRecordUnavailableError(
      "Quote references must belong to the active customer and organisation.",
    );
  }
  for (const line of lines) {
    if (!line.serviceId) continue;
    const service = await database
      .prepare(
        `SELECT id FROM services
         WHERE id = ? AND organisation_id = ? AND status = 'ACTIVE'
           AND asset_code = ? AND asset_scale = ?`,
      )
      .bind(line.serviceId, organisationId, assetCode, assetScale)
      .first<string>("id");
    if (!service)
      throw new CommercialRecordUnavailableError(
        "Every referenced service must be active in this organisation.",
      );
  }
}

function nextQuoteStatus(
  status: string,
  action: TransitionQuoteCommand["action"],
) {
  if (status === "DRAFT" && action === "ISSUE") return "ISSUED" as const;
  if (status === "ISSUED" && action === "APPROVE") return "APPROVED" as const;
  if (status === "ISSUED" && action === "REJECT") return "REJECTED" as const;
  if (status === "ISSUED" && action === "EXPIRE") return "EXPIRED" as const;
  throw new CommercialRecordUnavailableError(
    `Quote cannot ${action.toLowerCase()} from ${status}.`,
  );
}

async function writeCommand<T extends CommandResult>(
  database: D1Database,
  input: {
    context: Context;
    commandType: string;
    fingerprint: string;
    aggregateType: string;
    aggregateId: string;
    result: T;
    occurredAt: string;
    statements: readonly D1PreparedStatement[];
    evidence: JsonValue;
  },
): Promise<T> {
  try {
    await database.batch([
      ...input.statements,
      auditStatement(database, {
        id: crypto.randomUUID(),
        organisationId: input.context.organisationId,
        actorType: "USER",
        actorId: input.context.actorId,
        action: input.commandType.replace("TRANSITION_", ""),
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        correlationId: input.context.correlationId,
        causationId: input.context.commandId,
        evidence: input.evidence,
        occurredAt: input.occurredAt,
      }),
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
  } catch (error) {
    const raced = await receipt(database, input.context.commandId);
    if (raced) return replay<T>(raced, input.commandType, input.fingerprint);
    throw error;
  }
  return input.result;
}

async function receipt(database: D1Database, id: string) {
  return database
    .prepare(
      "SELECT command_type, command_fingerprint, result_json FROM application_command_receipts WHERE id = ?",
    )
    .bind(id)
    .first<Receipt>();
}

function replay<T extends CommandResult = CommandResult>(
  existing: Receipt,
  commandType: string,
  fingerprint: string,
): T {
  if (
    existing.command_type !== commandType ||
    existing.command_fingerprint !== fingerprint
  ) {
    throw new BusinessCommandConflictError(
      "The command identity was already used for different commercial data.",
    );
  }
  return {
    ...(JSON.parse(existing.result_json) as T),
    replayed: true,
  };
}

function context(value: Context): Context {
  return {
    commandId: required("Command ID", value.commandId),
    organisationId: required("Organisation ID", value.organisationId),
    actorId: required("Actor ID", value.actorId),
    correlationId: required("Correlation ID", value.correlationId),
  };
}

function required(label: string, value: string) {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} is required.`);
  if (normalized.length > 240) throw new TypeError(`${label} is too long.`);
  return normalized;
}

function optional(value?: string) {
  return value === undefined ? undefined : required("Optional value", value);
}

function positiveInteger(label: string, value: string) {
  if (!/^[1-9]\d*$/.test(value))
    throw new TypeError(`${label} must be a positive canonical integer.`);
  return value;
}

function timestamp(value: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(
      "Quote transition time must be an ISO 8601 UTC timestamp.",
    );
  }
  return value;
}
