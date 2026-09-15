import {
  createMoney,
  resolveApprovalBand,
  transitionSettlement,
  type SettlementState,
} from "@flowpay/domain";

import { hashCanonicalJson } from "./canonical-json.ts";
import { auditStatement, outboxStatement } from "./evidence-statements.ts";
import {
  StoredConfigurationError,
  parseApprovalPolicy,
} from "./record-parsers.ts";

export const MANUAL_SETTLEMENT_PERMISSION = "FLOWPAY_SETTLEMENT_RELEASE";

export type RecordManualSettlementControlCommand = Readonly<{
  commandId: string;
  organisationId: string;
  settlementId: string;
  actorId: string;
  actorPermissions: readonly string[];
  action: "RELEASE" | "CANCEL";
  reason?: string;
}>;

export type RecordManualSettlementControlResult = Readonly<{
  replayed: boolean;
  commandId: string;
  approvalRequestId: string;
  settlement: Readonly<{
    id: string;
    state: SettlementState;
    stateVersion: number;
  }>;
}>;

export class ManualSettlementControlConflictError extends Error {
  override readonly name = "ManualSettlementControlConflictError";
}

export class ManualSettlementControlNotAuthorizedError extends Error {
  override readonly name = "ManualSettlementControlNotAuthorizedError";
}

export class ManualSettlementControlUnavailableError extends Error {
  override readonly name = "ManualSettlementControlUnavailableError";
}

type ManualControlContext = Readonly<{
  approval_request_id: string;
  approval_request_status: string;
  policy_json: string;
  settlement_state: SettlementState;
  settlement_state_version: number;
  asset_code: string;
  amount_atomic: string;
  asset_scale: number;
  correlation_id: string;
}>;

type ExistingControl = Readonly<{
  id: string;
  organisation_id: string;
  settlement_id: string;
  to_state: SettlementState;
  to_version: number;
  command_fingerprint: string;
}>;

export async function recordManualSettlementControl(
  database: D1Database,
  command: RecordManualSettlementControlCommand,
): Promise<RecordManualSettlementControlResult> {
  const normalized = validateCommand(command);
  if (!normalized.actorPermissions.includes(MANUAL_SETTLEMENT_PERMISSION)) {
    throw new ManualSettlementControlNotAuthorizedError(
      `The actor requires ${MANUAL_SETTLEMENT_PERMISSION}.`,
    );
  }
  const fingerprint = await hashCanonicalJson({
    commandId: normalized.commandId,
    organisationId: normalized.organisationId,
    settlementId: normalized.settlementId,
    actorId: normalized.actorId,
    actorPermissions: normalized.actorPermissions,
    action: normalized.action,
    reason: normalized.reason ?? null,
  });
  const existing = await loadExistingControl(database, normalized.commandId);
  if (existing) {
    return resultFromExisting(database, normalized, fingerprint, existing);
  }
  const context = await loadContext(database, normalized);
  if (
    context.approval_request_status !== "PENDING" ||
    context.settlement_state !== "PENDING_APPROVAL"
  ) {
    throw new ManualSettlementControlUnavailableError(
      "The settlement is no longer waiting for a manual control action.",
    );
  }
  const policy = parsePolicy(context.policy_json);
  const band = resolveApprovalBand(
    policy,
    createMoney(context.asset_code, context.amount_atomic, context.asset_scale),
  );
  if (band.mode !== "MANUAL") {
    throw new ManualSettlementControlUnavailableError(
      "The settlement does not use a manual execution policy.",
    );
  }

  const now = new Date().toISOString();
  const targetState = transitionSettlement(
    context.settlement_state,
    normalized.action === "RELEASE" ? "MARK_READY" : "CANCEL",
  );
  const nextStateVersion = context.settlement_state_version + 1;
  const approvalStatus =
    normalized.action === "RELEASE" ? "APPROVED" : "CANCELLED";
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO settlement_state_transitions (
          id, organisation_id, settlement_id, from_state, to_state,
          from_version, to_version, action, actor_type, actor_id, reason,
          correlation_id, occurred_at, command_fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USER', ?, ?, ?, ?, ?)`,
        )
        .bind(
          normalized.commandId,
          normalized.organisationId,
          normalized.settlementId,
          context.settlement_state,
          targetState,
          context.settlement_state_version,
          nextStateVersion,
          normalized.action === "RELEASE" ? "MARK_READY" : "CANCEL",
          normalized.actorId,
          normalized.reason ?? null,
          context.correlation_id,
          now,
          fingerprint,
        ),
      database
        .prepare(
          `UPDATE settlements
         SET state = ?, state_version = ?, updated_at = ?
         WHERE id = ? AND organisation_id = ?
           AND state = ? AND state_version = ?`,
        )
        .bind(
          targetState,
          nextStateVersion,
          now,
          normalized.settlementId,
          normalized.organisationId,
          context.settlement_state,
          context.settlement_state_version,
        ),
      database
        .prepare(
          `UPDATE approval_requests
         SET status = ?, resolved_at = ?
         WHERE id = ? AND organisation_id = ? AND status = 'PENDING'`,
        )
        .bind(
          approvalStatus,
          now,
          context.approval_request_id,
          normalized.organisationId,
        ),
      auditStatement(database, {
        id: crypto.randomUUID(),
        organisationId: normalized.organisationId,
        actorType: "USER",
        actorId: normalized.actorId,
        action:
          normalized.action === "RELEASE"
            ? "MANUAL_SETTLEMENT_RELEASED"
            : "MANUAL_SETTLEMENT_CANCELLED",
        aggregateType: "SETTLEMENT",
        aggregateId: normalized.settlementId,
        correlationId: context.correlation_id,
        causationId: normalized.commandId,
        evidence: {
          commandId: normalized.commandId,
          approvalRequestId: context.approval_request_id,
          fromState: context.settlement_state,
          toState: targetState,
          stateVersion: nextStateVersion,
          ...(normalized.reason === undefined
            ? {}
            : { reason: normalized.reason }),
        },
        occurredAt: now,
      }),
      outboxStatement(database, {
        id: crypto.randomUUID(),
        organisationId: normalized.organisationId,
        messageType:
          normalized.action === "RELEASE"
            ? "FLOWPAY_SETTLEMENT_READY"
            : "FLOWPAY_SETTLEMENT_CANCELLED",
        aggregateType: "SETTLEMENT",
        aggregateId: normalized.settlementId,
        correlationId: context.correlation_id,
        causationId: normalized.commandId,
        payload: {
          settlementId: normalized.settlementId,
          commandId: normalized.commandId,
          state: targetState,
          stateVersion: nextStateVersion,
        },
        createdAt: now,
      }),
    ]);
  } catch (error) {
    const concurrentReplay = await loadExistingControl(
      database,
      normalized.commandId,
    );
    if (concurrentReplay) {
      return resultFromExisting(
        database,
        normalized,
        fingerprint,
        concurrentReplay,
      );
    }
    throw error;
  }

  return {
    replayed: false,
    commandId: normalized.commandId,
    approvalRequestId: context.approval_request_id,
    settlement: {
      id: normalized.settlementId,
      state: targetState,
      stateVersion: nextStateVersion,
    },
  };
}

async function loadExistingControl(
  database: D1Database,
  commandId: string,
): Promise<ExistingControl | null> {
  return database
    .prepare(
      `SELECT id, organisation_id, settlement_id, to_state, to_version,
              command_fingerprint
       FROM settlement_state_transitions WHERE id = ?`,
    )
    .bind(commandId)
    .first<ExistingControl>();
}

async function resultFromExisting(
  database: D1Database,
  command: RecordManualSettlementControlCommand,
  fingerprint: string,
  existing: ExistingControl,
): Promise<RecordManualSettlementControlResult> {
  if (
    existing.organisation_id !== command.organisationId ||
    existing.settlement_id !== command.settlementId ||
    existing.command_fingerprint !== fingerprint
  ) {
    throw new ManualSettlementControlConflictError(
      "The manual command identity was already used for different data.",
    );
  }
  const requestId = await findApprovalRequestId(
    database,
    command.organisationId,
    command.settlementId,
  );
  return {
    replayed: true,
    commandId: existing.id,
    approvalRequestId: requestId,
    settlement: {
      id: existing.settlement_id,
      state: existing.to_state,
      stateVersion: existing.to_version,
    },
  };
}

async function loadContext(
  database: D1Database,
  command: Pick<
    RecordManualSettlementControlCommand,
    "organisationId" | "settlementId"
  >,
): Promise<ManualControlContext> {
  const context = await database
    .prepare(
      `SELECT ar.id AS approval_request_id,
              ar.status AS approval_request_status, apv.policy_json,
              s.state AS settlement_state,
              s.state_version AS settlement_state_version,
              s.asset_code, s.amount_atomic, s.asset_scale,
              be.correlation_id
       FROM settlements s
       JOIN approval_requests ar ON ar.settlement_id = s.id
       JOIN approval_policy_versions apv ON apv.id = ar.policy_version_id
       JOIN business_events be ON be.id = s.source_event_id
       WHERE s.id = ? AND s.organisation_id = ?
         AND ar.organisation_id = ?`,
    )
    .bind(command.settlementId, command.organisationId, command.organisationId)
    .first<ManualControlContext>();
  if (!context) {
    throw new ManualSettlementControlUnavailableError(
      "The manual settlement control was not found in the organisation.",
    );
  }
  return context;
}

async function findApprovalRequestId(
  database: D1Database,
  organisationId: string,
  settlementId: string,
): Promise<string> {
  const requestId = await database
    .prepare(
      `SELECT id FROM approval_requests
       WHERE organisation_id = ? AND settlement_id = ?`,
    )
    .bind(organisationId, settlementId)
    .first<string>("id");
  if (!requestId) {
    throw new ManualSettlementControlUnavailableError(
      "The approval request for the replayed manual command was not found.",
    );
  }
  return requestId;
}

function parsePolicy(policyJson: string) {
  try {
    return parseApprovalPolicy(policyJson);
  } catch (error) {
    if (error instanceof StoredConfigurationError) {
      throw new ManualSettlementControlUnavailableError(error.message);
    }
    throw error;
  }
}

function validateCommand(
  command: RecordManualSettlementControlCommand,
): RecordManualSettlementControlCommand {
  requireIdentifier("Command ID", command.commandId);
  requireIdentifier("Organisation ID", command.organisationId);
  requireIdentifier("Settlement ID", command.settlementId);
  requireIdentifier("Actor ID", command.actorId);
  const permissions = [...command.actorPermissions].sort();
  for (const [index, permission] of permissions.entries()) {
    requireIdentifier("Actor permission", permission);
    if (permission === permissions[index - 1]) {
      throw new TypeError("Actor permissions must be unique.");
    }
  }
  if (command.reason !== undefined) {
    requireIdentifier("Control reason", command.reason);
  }
  if (command.action === "CANCEL" && command.reason === undefined) {
    throw new TypeError("Manual cancellation requires a reason.");
  }
  return { ...command, actorPermissions: permissions };
}

function requireIdentifier(label: string, value: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty trimmed string.`);
  }
}
