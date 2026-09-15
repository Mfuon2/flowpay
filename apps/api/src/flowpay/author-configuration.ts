import {
  validateApprovalPolicy,
  validateDistributionInstructions,
  validateSettlementRuleVersion,
  type ApprovalBand,
  type DistributionInstruction,
  type SettlementRuleCondition,
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

export type CreateApprovalPolicyCommand = Context &
  Readonly<{
    name: string;
    assetCode: string;
    assetScale: number;
    bands: readonly ApprovalBand[];
  }>;

export type CreateSettlementRuleCommand = Context &
  Readonly<{
    name: string;
    triggerEventType: string;
    triggerSchemaVersion: number;
    priority: number;
    effectiveFrom: string;
    effectiveTo?: string;
    conditions: readonly SettlementRuleCondition[];
    beneficiaries: readonly DistributionInstruction[];
    providerPolicy: Readonly<{
      providerKey: string;
      network: string;
      method: "INDIVIDUAL_TRANSFERS" | "ATOMIC_BATCH";
    }>;
    approvalPolicyVersionId: string;
  }>;

export type ConfigurationTransitionCommand = Context &
  Readonly<{
    configurationType: "APPROVAL_POLICY" | "SETTLEMENT_RULE";
    configurationId: string;
    action: "ACTIVATE" | "DEACTIVATE";
    reason?: string;
    occurredAt: string;
  }>;

type CreateResult = Readonly<{
  id: string;
  versionId: string;
  version: 1;
  status: "DRAFT";
  replayed: boolean;
}>;

type TransitionResult = Readonly<{
  id: string;
  status: "ACTIVE" | "INACTIVE";
  replayed: boolean;
}>;

type Receipt = Readonly<{
  command_type: string;
  command_fingerprint: string;
  result_json: string;
}>;

export class ConfigurationUnavailableError extends Error {
  override readonly name = "ConfigurationUnavailableError";
}

export async function createApprovalPolicy(
  database: D1Database,
  command: CreateApprovalPolicyCommand,
): Promise<CreateResult> {
  const context = normalizeContext(command);
  const policyId = `approval-policy:${crypto.randomUUID()}`;
  const versionId = `approval-policy-version:${crypto.randomUUID()}`;
  const policy = {
    id: versionId,
    policyId,
    version: 1,
    assetCode: command.assetCode,
    assetScale: command.assetScale,
    bands: command.bands,
  } as const;
  validateApprovalPolicy(policy);
  const normalized = {
    ...context,
    name: required("Policy name", command.name),
    assetCode: policy.assetCode,
    assetScale: policy.assetScale,
    bands: policy.bands,
  };
  const commandType = "CREATE_APPROVAL_POLICY";
  const fingerprint = await hashCanonicalJson({ commandType, ...normalized });
  const existing = await receipt(database, context.commandId);
  if (existing) return replay<CreateResult>(existing, commandType, fingerprint);
  const now = new Date().toISOString();
  const result: CreateResult = {
    id: policyId,
    versionId,
    version: 1,
    status: "DRAFT",
    replayed: false,
  };
  return createConfiguration(database, {
    context,
    commandType,
    fingerprint,
    aggregateType: "APPROVAL_POLICY",
    aggregateId: policyId,
    result,
    now,
    statements: [
      database
        .prepare(
          `INSERT INTO approval_policies (
            id, organisation_id, name, status, created_at, updated_at
          ) VALUES (?, ?, ?, 'DRAFT', ?, ?)`,
        )
        .bind(policyId, context.organisationId, normalized.name, now, now),
      database
        .prepare(
          `INSERT INTO approval_policy_versions (
            id, policy_id, version, policy_json, created_by, created_at
          ) VALUES (?, ?, 1, ?, ?, ?)`,
        )
        .bind(versionId, policyId, canonicalJson(policy), context.actorId, now),
    ],
  });
}

export async function createSettlementRule(
  database: D1Database,
  command: CreateSettlementRuleCommand,
): Promise<CreateResult> {
  const context = normalizeContext(command);
  const ruleId = `settlement-rule:${crypto.randomUUID()}`;
  const versionId = `settlement-rule-version:${crypto.randomUUID()}`;
  const rule = {
    id: versionId,
    ruleId,
    version: 1,
    triggerEventType: command.triggerEventType,
    triggerSchemaVersion: command.triggerSchemaVersion,
    conditions: command.conditions,
    beneficiaries: command.beneficiaries,
    approvalPolicyVersionId: command.approvalPolicyVersionId,
    providerPolicy: command.providerPolicy,
    effectiveFrom: command.effectiveFrom,
    ...(command.effectiveTo === undefined
      ? {}
      : { effectiveTo: command.effectiveTo }),
    priority: command.priority,
  } as const;
  validateSettlementRuleVersion(rule);
  validateDistributionInstructions(rule.beneficiaries);
  validateAmountIndependentAllocation(rule.beneficiaries);
  const normalized = {
    ...context,
    name: required("Rule name", command.name),
    triggerEventType: rule.triggerEventType,
    triggerSchemaVersion: rule.triggerSchemaVersion,
    priority: rule.priority,
    effectiveFrom: rule.effectiveFrom,
    ...(rule.effectiveTo === undefined
      ? {}
      : { effectiveTo: rule.effectiveTo }),
    conditions: rule.conditions,
    beneficiaries: rule.beneficiaries,
    providerPolicy: rule.providerPolicy,
    approvalPolicyVersionId: rule.approvalPolicyVersionId,
  };
  const commandType = "CREATE_SETTLEMENT_RULE";
  const fingerprint = await hashCanonicalJson({ commandType, ...normalized });
  const existing = await receipt(database, context.commandId);
  if (existing) return replay<CreateResult>(existing, commandType, fingerprint);
  await validateRuleReferences(database, context.organisationId, rule);
  const now = new Date().toISOString();
  const result: CreateResult = {
    id: ruleId,
    versionId,
    version: 1,
    status: "DRAFT",
    replayed: false,
  };
  return createConfiguration(database, {
    context,
    commandType,
    fingerprint,
    aggregateType: "SETTLEMENT_RULE",
    aggregateId: ruleId,
    result,
    now,
    statements: [
      database
        .prepare(
          `INSERT INTO settlement_rules (
            id, organisation_id, name, status, created_at, updated_at
          ) VALUES (?, ?, ?, 'DRAFT', ?, ?)`,
        )
        .bind(ruleId, context.organisationId, normalized.name, now, now),
      database
        .prepare(
          `INSERT INTO settlement_rule_versions (
            id, rule_id, version, trigger_event_type, trigger_schema_version,
            priority, effective_from, effective_to, conditions_json,
            beneficiaries_json, provider_policy_json,
            approval_policy_version_id, created_by, created_at
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          versionId,
          ruleId,
          rule.triggerEventType,
          rule.triggerSchemaVersion,
          rule.priority,
          rule.effectiveFrom,
          rule.effectiveTo ?? null,
          canonicalJson(rule.conditions),
          canonicalJson(rule.beneficiaries),
          canonicalJson(rule.providerPolicy),
          rule.approvalPolicyVersionId,
          context.actorId,
          now,
        ),
    ],
  });
}

export async function transitionConfiguration(
  database: D1Database,
  command: ConfigurationTransitionCommand,
): Promise<TransitionResult> {
  const normalized = {
    ...normalizeContext(command),
    configurationType: command.configurationType,
    configurationId: required("Configuration ID", command.configurationId),
    action: command.action,
    ...(optional(command.reason) === undefined
      ? {}
      : { reason: optional(command.reason) }),
    occurredAt: timestamp(command.occurredAt),
  };
  const fingerprint = await hashCanonicalJson(normalized);
  const table =
    normalized.configurationType === "APPROVAL_POLICY"
      ? "approval_policies"
      : "settlement_rules";
  const versionTable =
    normalized.configurationType === "APPROVAL_POLICY"
      ? "approval_policy_versions"
      : "settlement_rule_versions";
  const parentColumn =
    normalized.configurationType === "APPROVAL_POLICY"
      ? "policy_id"
      : "rule_id";
  const row = await database
    .prepare(`SELECT status FROM ${table} WHERE id = ? AND organisation_id = ?`)
    .bind(normalized.configurationId, normalized.organisationId)
    .first<{ status: "DRAFT" | "ACTIVE" | "INACTIVE" }>();
  if (!row)
    throw new ConfigurationUnavailableError("Configuration was not found.");
  const toStatus = normalized.action === "ACTIVATE" ? "ACTIVE" : "INACTIVE";
  const expected = normalized.action === "ACTIVATE" ? "DRAFT" : "ACTIVE";
  const transitionTable =
    normalized.configurationType === "APPROVAL_POLICY"
      ? "approval_policy_status_transitions"
      : "settlement_rule_status_transitions";
  const idColumn =
    normalized.configurationType === "APPROVAL_POLICY"
      ? "policy_id"
      : "rule_id";
  const existing = await database
    .prepare(`SELECT command_fingerprint FROM ${transitionTable} WHERE id = ?`)
    .bind(normalized.commandId)
    .first<string>("command_fingerprint");
  if (existing) {
    if (existing !== fingerprint)
      throw new BusinessCommandConflictError(
        "Configuration transition identity was reused.",
      );
    return { id: normalized.configurationId, status: toStatus, replayed: true };
  }
  if (row.status !== expected) {
    throw new ConfigurationUnavailableError(
      `${normalized.action} is not allowed from ${row.status}.`,
    );
  }
  if (normalized.action === "ACTIVATE") {
    const creator = await database
      .prepare(
        `SELECT created_by FROM ${versionTable}
         WHERE ${parentColumn} = ? ORDER BY version DESC LIMIT 1`,
      )
      .bind(normalized.configurationId)
      .first<string>("created_by");
    if (!creator || creator === normalized.actorId) {
      throw new ConfigurationUnavailableError(
        "Activation requires a different authorized reviewer from the version author.",
      );
    }
  }
  if (
    normalized.action === "ACTIVATE" &&
    normalized.configurationType === "SETTLEMENT_RULE"
  ) {
    await validateStoredRuleActivation(
      database,
      normalized.organisationId,
      normalized.configurationId,
    );
  }
  await database.batch([
    database
      .prepare(
        `INSERT INTO ${transitionTable} (
          id, organisation_id, ${idColumn}, from_status, to_status, action,
          actor_id, reason, correlation_id, command_fingerprint, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        normalized.commandId,
        normalized.organisationId,
        normalized.configurationId,
        expected,
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
        `UPDATE ${table} SET status = ?, updated_at = ? WHERE id = ? AND status = ?`,
      )
      .bind(
        toStatus,
        normalized.occurredAt,
        normalized.configurationId,
        expected,
      ),
    auditStatement(database, {
      id: crypto.randomUUID(),
      organisationId: normalized.organisationId,
      actorType: "USER",
      actorId: normalized.actorId,
      action: `${normalized.configurationType}_${toStatus}`,
      aggregateType: normalized.configurationType,
      aggregateId: normalized.configurationId,
      correlationId: normalized.correlationId,
      causationId: normalized.commandId,
      evidence: {
        fromStatus: expected,
        toStatus,
        reason: normalized.reason ?? null,
      },
      occurredAt: normalized.occurredAt,
    }),
  ]);
  return { id: normalized.configurationId, status: toStatus, replayed: false };
}

async function createConfiguration(
  database: D1Database,
  input: Readonly<{
    context: Context;
    commandType: string;
    fingerprint: string;
    aggregateType: "APPROVAL_POLICY" | "SETTLEMENT_RULE";
    aggregateId: string;
    result: CreateResult;
    now: string;
    statements: readonly D1PreparedStatement[];
  }>,
): Promise<CreateResult> {
  try {
    await database.batch([
      ...input.statements,
      auditStatement(database, {
        id: crypto.randomUUID(),
        organisationId: input.context.organisationId,
        actorType: "USER",
        actorId: input.context.actorId,
        action: `${input.aggregateType}_CREATED`,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        correlationId: input.context.correlationId,
        causationId: input.context.commandId,
        evidence: { versionId: input.result.versionId },
        occurredAt: input.now,
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
          input.now,
        ),
    ]);
  } catch (error) {
    const raced = await receipt(database, input.context.commandId);
    if (raced)
      return replay<CreateResult>(raced, input.commandType, input.fingerprint);
    throw error;
  }
  return input.result;
}

async function validateRuleReferences(
  database: D1Database,
  organisationId: string,
  rule: {
    approvalPolicyVersionId: string;
    beneficiaries: readonly DistributionInstruction[];
  },
): Promise<void> {
  const policy = await database
    .prepare(
      `SELECT apv.id FROM approval_policy_versions apv JOIN approval_policies ap ON ap.id = apv.policy_id
     WHERE apv.id = ? AND ap.organisation_id = ?`,
    )
    .bind(rule.approvalPolicyVersionId, organisationId)
    .first<string>("id");
  if (!policy)
    throw new ConfigurationUnavailableError(
      "Approval policy version is not in this organisation.",
    );
  for (const beneficiary of rule.beneficiaries) {
    const participant = await database
      .prepare(
        "SELECT id FROM participants WHERE id = ? AND organisation_id = ? AND status = 'ACTIVE'",
      )
      .bind(beneficiary.beneficiaryId, organisationId)
      .first<string>("id");
    if (!participant)
      throw new ConfigurationUnavailableError(
        `Beneficiary ${beneficiary.beneficiaryId} is not active in this organisation.`,
      );
  }
}

function validateAmountIndependentAllocation(
  beneficiaries: readonly DistributionInstruction[],
): void {
  if (beneficiaries.some(({ kind }) => kind === "REMAINDER")) return;
  if (beneficiaries.some(({ kind }) => kind === "FIXED")) {
    throw new TypeError(
      "A rule containing fixed amounts requires a remainder beneficiary.",
    );
  }
  const basisPoints = beneficiaries.reduce(
    (total, beneficiary) =>
      beneficiary.kind === "PERCENTAGE"
        ? total + beneficiary.basisPoints
        : total,
    0,
  );
  if (basisPoints !== 10_000) {
    throw new TypeError(
      "Percentage-only rules must total exactly 100% or include a remainder beneficiary.",
    );
  }
}

async function validateStoredRuleActivation(
  database: D1Database,
  organisationId: string,
  ruleId: string,
): Promise<void> {
  const row = await database
    .prepare(
      `SELECT srv.approval_policy_version_id FROM settlement_rule_versions srv
     JOIN approval_policy_versions apv ON apv.id = srv.approval_policy_version_id
     JOIN approval_policies ap ON ap.id = apv.policy_id
     WHERE srv.rule_id = ? AND srv.version = 1 AND ap.organisation_id = ? AND ap.status = 'ACTIVE'`,
    )
    .bind(ruleId, organisationId)
    .first();
  if (!row)
    throw new ConfigurationUnavailableError(
      "Activate the referenced approval policy before activating this rule.",
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

function replay<T extends Readonly<{ replayed: boolean }>>(
  existing: Receipt,
  type: string,
  fingerprint: string,
): T {
  if (
    existing.command_type !== type ||
    existing.command_fingerprint !== fingerprint
  ) {
    throw new BusinessCommandConflictError(
      "Configuration command identity was reused for different data.",
    );
  }
  return { ...(JSON.parse(existing.result_json) as T), replayed: true };
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
    throw new TypeError("Timestamp must be ISO 8601.");
  return value;
}
