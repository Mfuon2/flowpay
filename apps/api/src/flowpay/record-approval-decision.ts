import {
  createMoney,
  evaluateApprovals,
  resolveApprovalBand,
  transitionSettlement,
  type ApprovalDecision,
  type ApprovalPolicyVersion,
  type SettlementState,
} from "@flowpay/domain";

import { canonicalJson, hashCanonicalJson } from "./canonical-json.ts";
import { auditStatement, outboxStatement } from "./evidence-statements.ts";
import {
  StoredConfigurationError,
  parseApprovalPolicy,
} from "./record-parsers.ts";

export type RecordApprovalDecisionCommand = Readonly<{
  decisionId: string;
  organisationId: string;
  settlementId: string;
  actorId: string;
  actorRoles: readonly string[];
  decision: "APPROVE" | "REJECT";
  reason?: string;
}>;

export type RecordApprovalDecisionResult = Readonly<{
  replayed: boolean;
  decisionId: string;
  approvalRequestId: string;
  approvalOutcome: "PENDING" | "APPROVED" | "REJECTED";
  decisionVersion: number;
  settlement: Readonly<{
    id: string;
    state: SettlementState;
    stateVersion: number;
  }>;
}>;

export class ApprovalDecisionConflictError extends Error {
  override readonly name = "ApprovalDecisionConflictError";
}

export class ApprovalRequestClosedError extends Error {
  override readonly name = "ApprovalRequestClosedError";
}

export class ApprovalDecisionNotAuthorizedError extends Error {
  override readonly name = "ApprovalDecisionNotAuthorizedError";
}

export class ApprovalDecisionConfigurationError extends Error {
  override readonly name = "ApprovalDecisionConfigurationError";
}

type ApprovalContextRow = Readonly<{
  request_id: string;
  request_status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  decision_version: number;
  policy_json: string;
  settlement_id: string;
  settlement_state: SettlementState;
  settlement_state_version: number;
  asset_code: string;
  amount_atomic: string;
  asset_scale: number;
  initiated_by: string;
  correlation_id: string;
}>;

type ExistingDecisionRow = Readonly<{
  id: string;
  actor_id: string;
  decision_fingerprint: string;
}>;

type StoredDecisionRow = Readonly<{
  actor_id: string;
  actor_roles_json: string;
  decision: "APPROVE" | "REJECT";
  decided_at: string;
}>;

const MAX_CONCURRENCY_RETRIES = 3;

export async function recordApprovalDecision(
  database: D1Database,
  command: RecordApprovalDecisionCommand,
): Promise<RecordApprovalDecisionResult> {
  const normalized = validateCommand(command);
  const fingerprint = await hashCanonicalJson({
    decisionId: normalized.decisionId,
    organisationId: normalized.organisationId,
    settlementId: normalized.settlementId,
    actorId: normalized.actorId,
    actorRoles: normalized.actorRoles,
    decision: normalized.decision,
    reason: normalized.reason ?? null,
  });

  for (let attempt = 1; attempt <= MAX_CONCURRENCY_RETRIES; attempt += 1) {
    try {
      return await recordApprovalDecisionAttempt(
        database,
        normalized,
        fingerprint,
      );
    } catch (error) {
      if (isStaleApprovalError(error) && attempt < MAX_CONCURRENCY_RETRIES) {
        continue;
      }
      throw error;
    }
  }

  throw new ApprovalDecisionConflictError(
    "Approval decision could not be recorded after concurrent updates.",
  );
}

async function recordApprovalDecisionAttempt(
  database: D1Database,
  command: RecordApprovalDecisionCommand,
  fingerprint: string,
): Promise<RecordApprovalDecisionResult> {
  const context = await loadContext(database, command);
  const existing = await database
    .prepare(
      `SELECT id, actor_id, decision_fingerprint
       FROM approval_decisions
       WHERE approval_request_id = ? AND (id = ? OR actor_id = ?)
       LIMIT 1`,
    )
    .bind(context.request_id, command.decisionId, command.actorId)
    .first<ExistingDecisionRow>();

  if (existing) {
    if (
      existing.id !== command.decisionId ||
      existing.actor_id !== command.actorId ||
      existing.decision_fingerprint !== fingerprint
    ) {
      throw new ApprovalDecisionConflictError(
        "The decision or actor identity was already used for different approval data.",
      );
    }
    return resultFromContext(context, command.decisionId, true);
  }

  if (
    context.request_status !== "PENDING" ||
    context.settlement_state !== "PENDING_APPROVAL"
  ) {
    throw new ApprovalRequestClosedError(
      "The approval request is no longer open for decisions.",
    );
  }
  if (context.initiated_by.length === 0) {
    throw new ApprovalDecisionConfigurationError(
      "The settlement has no initiating actor for maker-checker enforcement.",
    );
  }

  const policy = parsePolicy(context.policy_json);
  const amount = createMoney(
    context.asset_code,
    context.amount_atomic,
    context.asset_scale,
  );
  const band = resolveApprovalBand(policy, amount);
  if (band.mode !== "APPROVAL_REQUIRED") {
    throw new ApprovalDecisionConfigurationError(
      "This approval service only accepts decisions for approval-required policy bands.",
    );
  }
  const eligibleRole = band.requirements.find(
    (requirement) =>
      command.actorRoles.includes(requirement.role) &&
      (requirement.allowSelfApproval ||
        command.actorId !== context.initiated_by),
  )?.role;
  if (!eligibleRole) {
    throw new ApprovalDecisionNotAuthorizedError(
      "The actor does not satisfy an eligible approval role and maker-checker rule.",
    );
  }

  const now = new Date().toISOString();
  const storedDecisions = await database
    .prepare(
      `SELECT actor_id, actor_roles_json, decision, decided_at
       FROM approval_decisions
       WHERE approval_request_id = ?
       ORDER BY request_version, id`,
    )
    .bind(context.request_id)
    .all<StoredDecisionRow>();
  const decisions = storedDecisions.results.map(parseStoredDecision);
  decisions.push({
    actorId: command.actorId,
    actorRoles: command.actorRoles,
    decision: command.decision === "APPROVE" ? "APPROVED" : "REJECTED",
    decidedAt: now,
  });
  const evaluation = evaluateApprovals({
    policy,
    amount,
    initiatedBy: context.initiated_by,
    decisions,
  });
  const approvalOutcome = normalizeOutcome(evaluation.outcome);
  const targetState = targetSettlementState(
    context.settlement_state,
    approvalOutcome,
  );
  const nextDecisionVersion = context.decision_version + 1;
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `INSERT INTO approval_decisions (
          id, approval_request_id, actor_id, actor_role, decision, reason,
          decided_at, actor_roles_json, request_version, decision_fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        command.decisionId,
        context.request_id,
        command.actorId,
        eligibleRole,
        command.decision,
        command.reason ?? null,
        now,
        canonicalJson(command.actorRoles),
        context.decision_version,
        fingerprint,
      ),
  ];

  if (approvalOutcome !== "PENDING") {
    statements.push(
      database
        .prepare(
          `UPDATE approval_requests
           SET status = ?, resolved_at = ?
           WHERE id = ? AND status = 'PENDING'`,
        )
        .bind(approvalOutcome, now, context.request_id),
    );
  }

  let nextStateVersion = context.settlement_state_version;
  if (targetState !== context.settlement_state) {
    nextStateVersion += 1;
    const action = approvalOutcome === "APPROVED" ? "MARK_READY" : "CANCEL";
    statements.push(
      database
        .prepare(
          `INSERT INTO settlement_state_transitions (
            id, organisation_id, settlement_id, from_state, to_state,
            from_version, to_version, action, actor_type, actor_id, reason,
            correlation_id, occurred_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USER', ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          command.organisationId,
          command.settlementId,
          context.settlement_state,
          targetState,
          context.settlement_state_version,
          nextStateVersion,
          action,
          command.actorId,
          command.reason ?? null,
          context.correlation_id,
          now,
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
          command.settlementId,
          command.organisationId,
          context.settlement_state,
          context.settlement_state_version,
        ),
    );
  }

  statements.push(
    auditStatement(database, {
      id: crypto.randomUUID(),
      organisationId: command.organisationId,
      actorType: "USER",
      actorId: command.actorId,
      action: "APPROVAL_DECISION_RECORDED",
      aggregateType: "SETTLEMENT",
      aggregateId: command.settlementId,
      correlationId: context.correlation_id,
      causationId: command.decisionId,
      evidence: {
        approvalRequestId: context.request_id,
        decisionId: command.decisionId,
        decision: command.decision,
        eligibleRole,
        approvalOutcome,
        decisionVersion: nextDecisionVersion,
        settlementState: targetState,
        settlementStateVersion: nextStateVersion,
        ...(command.reason === undefined ? {} : { reason: command.reason }),
      },
      occurredAt: now,
    }),
    outboxStatement(database, {
      id: crypto.randomUUID(),
      organisationId: command.organisationId,
      messageType:
        approvalOutcome === "APPROVED"
          ? "FLOWPAY_SETTLEMENT_READY"
          : approvalOutcome === "REJECTED"
            ? "FLOWPAY_SETTLEMENT_APPROVAL_REJECTED"
            : "FLOWPAY_APPROVAL_DECISION_RECORDED",
      aggregateType: "SETTLEMENT",
      aggregateId: command.settlementId,
      correlationId: context.correlation_id,
      causationId: command.decisionId,
      payload: {
        settlementId: command.settlementId,
        approvalRequestId: context.request_id,
        decisionId: command.decisionId,
        approvalOutcome,
        decisionVersion: nextDecisionVersion,
        settlementState: targetState,
        settlementStateVersion: nextStateVersion,
      },
      createdAt: now,
    }),
  );

  await database.batch(statements);
  return {
    replayed: false,
    decisionId: command.decisionId,
    approvalRequestId: context.request_id,
    approvalOutcome,
    decisionVersion: nextDecisionVersion,
    settlement: {
      id: command.settlementId,
      state: targetState,
      stateVersion: nextStateVersion,
    },
  };
}

async function loadContext(
  database: D1Database,
  command: Pick<
    RecordApprovalDecisionCommand,
    "organisationId" | "settlementId"
  >,
): Promise<ApprovalContextRow> {
  const context = await database
    .prepare(
      `SELECT ar.id AS request_id, ar.status AS request_status,
              ar.decision_version, apv.policy_json,
              s.id AS settlement_id, s.state AS settlement_state,
              s.state_version AS settlement_state_version, s.asset_code,
              s.amount_atomic, s.asset_scale, s.initiated_by,
              be.correlation_id
       FROM approval_requests ar
       JOIN settlements s ON s.id = ar.settlement_id
       JOIN approval_policy_versions apv ON apv.id = ar.policy_version_id
       JOIN business_events be ON be.id = s.source_event_id
       WHERE s.id = ? AND s.organisation_id = ?
         AND ar.organisation_id = ?`,
    )
    .bind(command.settlementId, command.organisationId, command.organisationId)
    .first<ApprovalContextRow>();
  if (!context) {
    throw new ApprovalDecisionConfigurationError(
      "Settlement approval request was not found in the organisation.",
    );
  }
  return context;
}

function parsePolicy(policyJson: string): ApprovalPolicyVersion {
  try {
    return parseApprovalPolicy(policyJson);
  } catch (error) {
    if (error instanceof StoredConfigurationError) {
      throw new ApprovalDecisionConfigurationError(error.message);
    }
    throw error;
  }
}

function parseStoredDecision(row: StoredDecisionRow): ApprovalDecision {
  let actorRoles: unknown;
  try {
    actorRoles = JSON.parse(row.actor_roles_json) as unknown;
  } catch {
    throw new ApprovalDecisionConfigurationError(
      "Stored approval actor roles are not valid JSON.",
    );
  }
  if (
    !Array.isArray(actorRoles) ||
    !actorRoles.every((role) => typeof role === "string")
  ) {
    throw new ApprovalDecisionConfigurationError(
      "Stored approval actor roles must be a string array.",
    );
  }
  return {
    actorId: row.actor_id,
    actorRoles,
    decision: row.decision === "APPROVE" ? "APPROVED" : "REJECTED",
    decidedAt: row.decided_at,
  };
}

function targetSettlementState(
  current: SettlementState,
  outcome: "PENDING" | "APPROVED" | "REJECTED",
): SettlementState {
  if (outcome === "PENDING") return current;
  return transitionSettlement(
    current,
    outcome === "APPROVED" ? "MARK_READY" : "CANCEL",
  );
}

function normalizeOutcome(
  outcome: ReturnType<typeof evaluateApprovals>["outcome"],
): "PENDING" | "APPROVED" | "REJECTED" {
  if (outcome === "APPROVED" || outcome === "REJECTED") return outcome;
  if (outcome === "PENDING") return outcome;
  throw new ApprovalDecisionConfigurationError(
    "Approval policy produced an unsupported decision outcome.",
  );
}

function resultFromContext(
  context: ApprovalContextRow,
  decisionId: string,
  replayed: boolean,
): RecordApprovalDecisionResult {
  const approvalOutcome =
    context.request_status === "APPROVED" ||
    context.request_status === "REJECTED"
      ? context.request_status
      : "PENDING";
  return {
    replayed,
    decisionId,
    approvalRequestId: context.request_id,
    approvalOutcome,
    decisionVersion: context.decision_version,
    settlement: {
      id: context.settlement_id,
      state: context.settlement_state,
      stateVersion: context.settlement_state_version,
    },
  };
}

function validateCommand(
  command: RecordApprovalDecisionCommand,
): RecordApprovalDecisionCommand {
  requireIdentifier("Decision ID", command.decisionId);
  requireIdentifier("Organisation ID", command.organisationId);
  requireIdentifier("Settlement ID", command.settlementId);
  requireIdentifier("Actor ID", command.actorId);
  if (command.actorRoles.length === 0) {
    throw new TypeError("At least one actor role is required.");
  }
  const actorRoles = [...command.actorRoles].sort();
  for (const [index, role] of actorRoles.entries()) {
    requireIdentifier("Actor role", role);
    if (role === actorRoles[index - 1]) {
      throw new TypeError("Actor roles must be unique.");
    }
  }
  if (command.reason !== undefined) {
    requireIdentifier("Decision reason", command.reason);
  }
  if (command.decision === "REJECT" && command.reason === undefined) {
    throw new TypeError("Rejected approvals require a reason.");
  }
  return { ...command, actorRoles };
}

function isStaleApprovalError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("stale or closed approval request")
  );
}

function requireIdentifier(label: string, value: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty trimmed string.`);
  }
}
