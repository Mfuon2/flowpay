import {
  createMoney,
  serializeMoney,
  transitionEscrow,
  validateEscrowMilestones,
  type EscrowState,
  type JsonValue,
} from "@flowpay/domain";

import { canonicalJson, hashCanonicalJson } from "./canonical-json.ts";
import { auditStatement } from "./evidence-statements.ts";
import { BusinessCommandConflictError } from "../business/create-party.ts";

type Context = Readonly<{
  commandId: string;
  organisationId: string;
  actorId: string;
  correlationId: string;
}>;

export type CreateEscrowCommand = Context &
  Readonly<{
    name: string;
    fundingPaymentId: string;
    milestones: readonly Readonly<{
      name: string;
      verificationEventType: string;
      releaseAmountAtomic: string;
    }>[];
  }>;

export type TransitionEscrowCommand = Context &
  Readonly<{
    escrowId: string;
    action:
      | "ACTIVATE"
      | "CONFIRM_FUNDING"
      | "OPEN_DISPUTE"
      | "RESOLVE_TO_FUNDED"
      | "RESOLVE_TO_PARTIALLY_RELEASED"
      | "CANCEL";
    reason?: string;
    occurredAt: string;
  }>;

type Receipt = Readonly<{
  command_type: string;
  command_fingerprint: string;
  result_json: string;
}>;

type EscrowRow = Readonly<{
  state: EscrowState;
  state_version: number;
  funding_payment_id: string;
  payment_status: string;
  payment_asset_code: string;
  payment_amount_atomic: string;
  payment_asset_scale: number;
}>;

export class EscrowCommandUnavailableError extends Error {
  override readonly name = "EscrowCommandUnavailableError";
}

export async function createEscrow(
  database: D1Database,
  command: CreateEscrowCommand,
): Promise<
  Readonly<{
    id: string;
    state: "DRAFT";
    assetCode: string;
    amountAtomic: string;
    assetScale: number;
    replayed: boolean;
  }>
> {
  const context = normalizeContext(command);
  const normalizedInput = {
    ...context,
    name: required("Escrow name", command.name),
    fundingPaymentId: required("Funding payment", command.fundingPaymentId),
    milestones: command.milestones.map((milestone) => ({
      name: required("Milestone name", milestone.name),
      verificationEventType: required(
        "Milestone verification event",
        milestone.verificationEventType,
      ),
      releaseAmountAtomic: required(
        "Milestone release amount",
        milestone.releaseAmountAtomic,
      ),
    })),
  };
  const commandType = "CREATE_ESCROW";
  const fingerprint = await hashCanonicalJson({
    commandType,
    ...normalizedInput,
  });
  const existing = await receipt(database, context.commandId);
  if (existing) return replayCreate(existing, commandType, fingerprint);
  const funding = await database
    .prepare(
      `SELECT asset_code, amount_atomic, asset_scale, status
       FROM payments WHERE id = ? AND organisation_id = ?
         AND status IN ('PENDING', 'CONFIRMED')`,
    )
    .bind(normalizedInput.fundingPaymentId, context.organisationId)
    .first<{
      asset_code: string;
      amount_atomic: string;
      asset_scale: number;
      status: string;
    }>();
  if (!funding) {
    throw new EscrowCommandUnavailableError(
      "Escrow requires a pending or confirmed funding payment in this organisation.",
    );
  }
  const total = createMoney(
    funding.asset_code,
    funding.amount_atomic,
    funding.asset_scale,
  );
  const escrowId = `escrow:${crypto.randomUUID()}`;
  const milestones = normalizedInput.milestones.map((milestone, position) => ({
    id: `escrow-milestone:${crypto.randomUUID()}`,
    position,
    name: milestone.name,
    verificationEventType: milestone.verificationEventType,
    releaseAmount: serializeMoney(
      createMoney(
        funding.asset_code,
        milestone.releaseAmountAtomic,
        funding.asset_scale,
      ),
    ),
  }));
  validateEscrowMilestones(total, milestones);
  const now = new Date().toISOString();
  const result = {
    id: escrowId,
    state: "DRAFT" as const,
    assetCode: funding.asset_code,
    amountAtomic: funding.amount_atomic,
    assetScale: funding.asset_scale,
    replayed: false,
  };
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO escrow_arrangements (
            id, organisation_id, name, funding_payment_id, asset_code,
            amount_atomic, asset_scale, state, state_version, created_by,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', 0, ?, ?, ?)`,
        )
        .bind(
          escrowId,
          context.organisationId,
          normalizedInput.name,
          normalizedInput.fundingPaymentId,
          funding.asset_code,
          funding.amount_atomic,
          funding.asset_scale,
          context.actorId,
          now,
          now,
        ),
      ...milestones.map((milestone) =>
        database
          .prepare(
            `INSERT INTO escrow_milestones (
              id, escrow_arrangement_id, position, name,
              verification_event_type, asset_code, release_amount_atomic,
              asset_scale, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            milestone.id,
            escrowId,
            milestone.position,
            milestone.name,
            milestone.verificationEventType,
            milestone.releaseAmount.assetCode,
            milestone.releaseAmount.atomicAmount,
            milestone.releaseAmount.scale,
            now,
          ),
      ),
      auditStatement(database, {
        id: crypto.randomUUID(),
        organisationId: context.organisationId,
        actorType: "USER",
        actorId: context.actorId,
        action: "ESCROW_CREATED",
        aggregateType: "ESCROW",
        aggregateId: escrowId,
        correlationId: context.correlationId,
        causationId: context.commandId,
        evidence: {
          fundingPaymentId: normalizedInput.fundingPaymentId,
          amount: serializeMoney(total),
          milestones: milestones.map(({ id, position, releaseAmount }) => ({
            id,
            position,
            releaseAmount,
          })),
        },
        occurredAt: now,
      }),
      receiptStatement(
        database,
        context,
        commandType,
        fingerprint,
        escrowId,
        result,
        now,
      ),
    ]);
  } catch (error) {
    const raced = await receipt(database, context.commandId);
    if (raced) return replayCreate(raced, commandType, fingerprint);
    throw error;
  }
  return result;
}

export async function transitionEscrowArrangement(
  database: D1Database,
  command: TransitionEscrowCommand,
): Promise<
  Readonly<{
    id: string;
    state: EscrowState;
    stateVersion: number;
    replayed: boolean;
  }>
> {
  const normalized = {
    ...normalizeContext(command),
    escrowId: required("Escrow ID", command.escrowId),
    action: command.action,
    ...(optional(command.reason) === undefined
      ? {}
      : { reason: optional(command.reason) }),
    occurredAt: timestamp(command.occurredAt),
  };
  if (
    (normalized.action === "CANCEL" || normalized.action === "OPEN_DISPUTE") &&
    !normalized.reason
  ) {
    throw new TypeError(`${normalized.action} requires a reason.`);
  }
  const fingerprint = await hashCanonicalJson(normalized);
  const existing = await database
    .prepare(
      `SELECT escrow_arrangement_id, to_state, to_version, command_fingerprint
     FROM escrow_state_transitions WHERE id = ?`,
    )
    .bind(normalized.commandId)
    .first<{
      escrow_arrangement_id: string;
      to_state: EscrowState;
      to_version: number;
      command_fingerprint: string;
    }>();
  if (existing) {
    if (
      existing.escrow_arrangement_id !== normalized.escrowId ||
      existing.command_fingerprint !== fingerprint
    ) {
      throw new BusinessCommandConflictError(
        "Escrow transition identity was reused for different evidence.",
      );
    }
    return {
      id: normalized.escrowId,
      state: existing.to_state,
      stateVersion: existing.to_version,
      replayed: true,
    };
  }
  const row = await loadEscrow(
    database,
    normalized.organisationId,
    normalized.escrowId,
  );
  if (
    normalized.action === "CONFIRM_FUNDING" &&
    row.payment_status !== "CONFIRMED"
  ) {
    throw new EscrowCommandUnavailableError(
      "Funding payment is not confirmed.",
    );
  }
  const next = transitionEscrow(row.state, normalized.action);
  const nextVersion = row.state_version + 1;
  await database.batch([
    database
      .prepare(
        `INSERT INTO escrow_state_transitions (
        id, organisation_id, escrow_arrangement_id, from_state, to_state,
        from_version, to_version, action, actor_type, actor_id, reason,
        correlation_id, occurred_at, command_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USER', ?, ?, ?, ?, ?)`,
      )
      .bind(
        normalized.commandId,
        normalized.organisationId,
        normalized.escrowId,
        row.state,
        next,
        row.state_version,
        nextVersion,
        normalized.action,
        normalized.actorId,
        normalized.reason ?? null,
        normalized.correlationId,
        normalized.occurredAt,
        fingerprint,
      ),
    database
      .prepare(
        `UPDATE escrow_arrangements SET state = ?, state_version = ?, updated_at = ?
       WHERE id = ? AND organisation_id = ? AND state = ? AND state_version = ?`,
      )
      .bind(
        next,
        nextVersion,
        normalized.occurredAt,
        normalized.escrowId,
        normalized.organisationId,
        row.state,
        row.state_version,
      ),
    auditStatement(database, {
      id: crypto.randomUUID(),
      organisationId: normalized.organisationId,
      actorType: "USER",
      actorId: normalized.actorId,
      action: `ESCROW_${normalized.action}`,
      aggregateType: "ESCROW",
      aggregateId: normalized.escrowId,
      correlationId: normalized.correlationId,
      causationId: normalized.commandId,
      evidence: {
        fromState: row.state,
        toState: next,
        reason: normalized.reason ?? null,
      },
      occurredAt: normalized.occurredAt,
    }),
  ]);
  return {
    id: normalized.escrowId,
    state: next,
    stateVersion: nextVersion,
    replayed: false,
  };
}

async function loadEscrow(
  database: D1Database,
  organisationId: string,
  escrowId: string,
): Promise<EscrowRow> {
  const row = await database
    .prepare(
      `SELECT ea.state, ea.state_version, ea.funding_payment_id,
            p.status AS payment_status, p.asset_code AS payment_asset_code,
            p.amount_atomic AS payment_amount_atomic, p.asset_scale AS payment_asset_scale
     FROM escrow_arrangements ea JOIN payments p ON p.id = ea.funding_payment_id
     WHERE ea.id = ? AND ea.organisation_id = ?`,
    )
    .bind(escrowId, organisationId)
    .first<EscrowRow>();
  if (!row)
    throw new EscrowCommandUnavailableError(
      "Escrow arrangement was not found.",
    );
  return row;
}

function receiptStatement(
  database: D1Database,
  context: Context,
  commandType: string,
  fingerprint: string,
  aggregateId: string,
  result: JsonValue,
  now: string,
) {
  return database
    .prepare(
      `INSERT INTO application_command_receipts (
      id, organisation_id, command_type, command_fingerprint,
      aggregate_type, aggregate_id, result_json, completed_at
    ) VALUES (?, ?, ?, ?, 'ESCROW', ?, ?, ?)`,
    )
    .bind(
      context.commandId,
      context.organisationId,
      commandType,
      fingerprint,
      aggregateId,
      canonicalJson(result),
      now,
    );
}
async function receipt(
  database: D1Database,
  id: string,
): Promise<Receipt | null> {
  return database
    .prepare(
      "SELECT command_type, command_fingerprint, result_json FROM application_command_receipts WHERE id = ?",
    )
    .bind(id)
    .first<Receipt>();
}
function replayCreate(existing: Receipt, type: string, fingerprint: string) {
  if (
    existing.command_type !== type ||
    existing.command_fingerprint !== fingerprint
  )
    throw new BusinessCommandConflictError(
      "Escrow command identity was reused for different data.",
    );
  const result = JSON.parse(existing.result_json) as {
    id: string;
    state: "DRAFT";
    assetCode: string;
    amountAtomic: string;
    assetScale: number;
    replayed: boolean;
  };
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
  const result = value.trim();
  if (!result) throw new TypeError(`${label} is required.`);
  if (result.length > 500) throw new TypeError(`${label} is too long.`);
  return result;
}
function optional(value?: string): string | undefined {
  const result = value?.trim();
  return result ? required("Optional text", result) : undefined;
}
function timestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value)))
    throw new TypeError("Escrow transition time must be ISO 8601.");
  return value;
}
