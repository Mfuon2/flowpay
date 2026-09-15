import { canonicalJson, hashCanonicalJson } from "./canonical-json.ts";
import { auditStatement, outboxStatement } from "./evidence-statements.ts";
import {
  calculateDistributions,
  createBusinessEvent,
  deserializeMoney,
  evaluateApprovals,
  selectSettlementRule,
  serializeMoney,
  type BusinessEvent,
  type JsonValue,
  type RuleFacts,
  type SerializedMoney,
  type SettlementRuleVersion,
  type SettlementState,
} from "@flowpay/domain";

import {
  StoredConfigurationError,
  parseApprovalPolicy,
  parseSettlementRuleRow,
  type SettlementRuleRow,
} from "./record-parsers.ts";

export type RecordBusinessEventCommand = Readonly<{
  event: BusinessEvent<JsonValue>;
  facts: RuleFacts;
  settlementAmount: SerializedMoney;
  initiatedBy: string;
}>;

export type RecordBusinessEventResult = Readonly<{
  replayed: boolean;
  eventId: string;
  evaluationId: string;
  outcome: "NO_MATCH" | "MATCHED" | "CONFLICT";
  settlement?: Readonly<{
    id: string;
    state: SettlementState;
  }>;
}>;

export class EventReplayConflictError extends Error {
  override readonly name = "EventReplayConflictError";
}

export class FlowPayConfigurationError extends Error {
  override readonly name = "FlowPayConfigurationError";
}

type ExistingEventRow = Readonly<{
  event_id: string;
  deduplication_hash: string;
  evaluation_id: string | null;
  evaluation_outcome: "NO_MATCH" | "MATCHED" | "CONFLICT" | null;
  settlement_id: string | null;
  settlement_state: SettlementState | null;
}>;

type ApprovalPolicyRow = Readonly<{
  id: string;
  policy_json: string;
}>;

type ParticipantRow = Readonly<{ id: string; status: string }>;

export async function recordBusinessEvent(
  database: D1Database,
  command: RecordBusinessEventCommand,
): Promise<RecordBusinessEventResult> {
  const event = createBusinessEvent(command.event);
  requireIdentifier("Initiating actor", command.initiatedBy);
  const amount = deserializeMoney(command.settlementAmount);
  const deduplicationHash = await hashCanonicalJson({
    event: {
      organisationId: event.organisationId,
      source: event.source,
      externalEventId: event.externalEventId,
      eventType: event.eventType,
      schemaVersion: event.schemaVersion,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      occurredAt: event.occurredAt,
      payload: event.payload,
    },
    facts: command.facts,
    settlementAmount: command.settlementAmount,
  });

  const existing = await findExistingEvent(database, event);
  if (existing) return replay(existing, deduplicationHash);

  const rules = await loadRules(database, event);
  const selection = selectSettlementRule({
    eventType: event.eventType,
    eventSchemaVersion: event.schemaVersion,
    occurredAt: event.occurredAt,
    facts: command.facts,
    rules,
  });
  const now = new Date().toISOString();
  const evaluationId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `INSERT INTO business_events (
          id, organisation_id, source, external_event_id, event_type,
          schema_version, aggregate_type, aggregate_id, occurred_at,
          recorded_at, correlation_id, causation_id, payload_json,
          deduplication_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        event.id,
        event.organisationId,
        event.source,
        event.externalEventId,
        event.eventType,
        event.schemaVersion,
        event.aggregateType,
        event.aggregateId,
        event.occurredAt,
        event.recordedAt,
        event.correlationId,
        event.causationId ?? null,
        canonicalJson(event.payload),
        deduplicationHash,
      ),
  ];

  let settlementResult: RecordBusinessEventResult["settlement"];
  let matchedRuleVersionId: string | null = null;
  const evaluationEvidence = selectionEvidence(selection);

  if (selection.outcome === "MATCHED") {
    matchedRuleVersionId = selection.rule.id;
    settlementResult = await appendMatchedSettlementStatements(
      database,
      statements,
      event,
      command,
      selection.rule,
      amount,
      evaluationEvidence,
      now,
    );
  }

  statements.splice(
    1,
    0,
    database
      .prepare(
        `INSERT INTO rule_evaluations (
          id, organisation_id, business_event_id, outcome,
          matched_rule_version_id, evidence_json, evaluated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        evaluationId,
        event.organisationId,
        event.id,
        selection.outcome,
        matchedRuleVersionId,
        canonicalJson(evaluationEvidence),
        now,
      ),
    auditStatement(database, {
      id: crypto.randomUUID(),
      organisationId: event.organisationId,
      actorType: "SERVICE",
      actorId: command.initiatedBy,
      action: "SETTLEMENT_RULE_EVALUATED",
      aggregateType: "BUSINESS_EVENT",
      aggregateId: event.id,
      correlationId: event.correlationId,
      causationId: event.causationId,
      evidence: {
        evaluationId,
        outcome: selection.outcome,
        matchedRuleVersionId,
      },
      occurredAt: now,
    }),
    outboxStatement(database, {
      id: crypto.randomUUID(),
      organisationId: event.organisationId,
      messageType: "FLOWPAY_RULE_EVALUATION_COMPLETED",
      aggregateType: "BUSINESS_EVENT",
      aggregateId: event.id,
      correlationId: event.correlationId,
      causationId: event.causationId,
      payload: {
        eventId: event.id,
        evaluationId,
        outcome: selection.outcome,
        matchedRuleVersionId,
      },
      createdAt: now,
    }),
  );

  try {
    await database.batch(statements);
  } catch (error) {
    if (isEventIdentityConflict(error)) {
      const racedEvent = await findExistingEvent(database, event);
      if (racedEvent) return replay(racedEvent, deduplicationHash);
    }
    throw error;
  }

  return {
    replayed: false,
    eventId: event.id,
    evaluationId,
    outcome: selection.outcome,
    ...(settlementResult === undefined ? {} : { settlement: settlementResult }),
  };
}

async function appendMatchedSettlementStatements(
  database: D1Database,
  statements: D1PreparedStatement[],
  event: BusinessEvent<JsonValue>,
  command: RecordBusinessEventCommand,
  rule: SettlementRuleVersion,
  amount: ReturnType<typeof deserializeMoney>,
  evaluationEvidence: JsonValue,
  now: string,
): Promise<NonNullable<RecordBusinessEventResult["settlement"]>> {
  if (rule.approvalPolicyVersionId === undefined) {
    throw new FlowPayConfigurationError(
      `Active rule version ${rule.id} has no approval policy version.`,
    );
  }
  const policyRow = await database
    .prepare(
      `SELECT apv.id, apv.policy_json
       FROM approval_policy_versions apv
       JOIN approval_policies ap ON ap.id = apv.policy_id
       WHERE apv.id = ? AND ap.organisation_id = ? AND ap.status = 'ACTIVE'`,
    )
    .bind(rule.approvalPolicyVersionId, event.organisationId)
    .first<ApprovalPolicyRow>();
  if (!policyRow) {
    throw new FlowPayConfigurationError(
      `Approval policy version ${rule.approvalPolicyVersionId} is not active for the organisation.`,
    );
  }
  const policy = parseApprovalPolicy(policyRow.policy_json);
  if (policy.id !== policyRow.id) {
    throw new FlowPayConfigurationError(
      "Approval policy JSON identity does not match its stored row.",
    );
  }

  const calculation = calculateDistributions(amount, rule.beneficiaries);
  await validateBeneficiaries(
    database,
    event.organisationId,
    calculation.distributions.map(({ beneficiaryId }) => beneficiaryId),
  );
  const approval = evaluateApprovals({
    policy,
    amount,
    initiatedBy: command.initiatedBy,
    decisions: [],
  });
  const state: SettlementState =
    approval.outcome === "AUTOMATICALLY_APPROVED"
      ? "READY"
      : "PENDING_APPROVAL";
  const settlementId = crypto.randomUUID();
  const approvalRequestId = crypto.randomUUID();
  const serializedAmount = serializeMoney(amount);

  statements.push(
    database
      .prepare(
        `INSERT INTO settlements (
          id, organisation_id, source_event_id, rule_version_id,
          approval_policy_version_id, asset_code, amount_atomic, asset_scale,
          state, evaluation_evidence_json, created_at, updated_at, initiated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        settlementId,
        event.organisationId,
        event.id,
        rule.id,
        policy.id,
        serializedAmount.assetCode,
        serializedAmount.atomicAmount,
        serializedAmount.scale,
        state,
        canonicalJson({
          ruleEvaluation: evaluationEvidence,
          calculation: calculation.distributions.map((distribution) => ({
            beneficiaryId: distribution.beneficiaryId,
            instructionKind: distribution.instructionKind,
            amount: serializeMoney(distribution.amount),
            roundingAdjustmentAtomic: distribution.roundingAdjustmentAtomic,
          })),
          approval: {
            policyVersionId: policy.id,
            mode: approval.band.mode,
            outcome: approval.outcome,
          },
        }),
        now,
        now,
        command.initiatedBy,
      ),
  );

  for (const [position, distribution] of calculation.distributions.entries()) {
    const instruction = rule.beneficiaries[position];
    if (!instruction) {
      throw new FlowPayConfigurationError(
        "Calculated distribution has no originating instruction.",
      );
    }
    const serializedDistribution = serializeMoney(distribution.amount);
    statements.push(
      database
        .prepare(
          `INSERT INTO settlement_distributions (
            id, settlement_id, beneficiary_id, position, calculation_kind,
            calculation_json, asset_code, amount_atomic, asset_scale, state,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          settlementId,
          distribution.beneficiaryId,
          position,
          distribution.instructionKind,
          canonicalJson({
            instruction,
            roundingAdjustmentAtomic: distribution.roundingAdjustmentAtomic,
          }),
          serializedDistribution.assetCode,
          serializedDistribution.atomicAmount,
          serializedDistribution.scale,
          "PENDING",
          now,
          now,
        ),
    );
  }

  statements.push(
    database
      .prepare(
        `INSERT INTO approval_requests (
          id, organisation_id, settlement_id, policy_version_id, status,
          requirements_json, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        approvalRequestId,
        event.organisationId,
        settlementId,
        policy.id,
        approval.outcome === "AUTOMATICALLY_APPROVED" ? "APPROVED" : "PENDING",
        canonicalJson({
          mode: approval.band.mode,
          requirements: approval.band.requirements,
        }),
        now,
        approval.outcome === "AUTOMATICALLY_APPROVED" ? now : null,
      ),
    auditStatement(database, {
      id: crypto.randomUUID(),
      organisationId: event.organisationId,
      actorType: "SERVICE",
      actorId: command.initiatedBy,
      action: "SETTLEMENT_CREATED",
      aggregateType: "SETTLEMENT",
      aggregateId: settlementId,
      correlationId: event.correlationId,
      causationId: event.id,
      evidence: {
        sourceEventId: event.id,
        ruleVersionId: rule.id,
        approvalPolicyVersionId: policy.id,
        approvalRequestId,
        state,
      },
      occurredAt: now,
    }),
    outboxStatement(database, {
      id: crypto.randomUUID(),
      organisationId: event.organisationId,
      messageType: "FLOWPAY_SETTLEMENT_CREATED",
      aggregateType: "SETTLEMENT",
      aggregateId: settlementId,
      correlationId: event.correlationId,
      causationId: event.id,
      payload: {
        settlementId,
        sourceEventId: event.id,
        state,
      },
      createdAt: now,
    }),
  );

  if (state === "READY") {
    statements.push(
      outboxStatement(database, {
        id: crypto.randomUUID(),
        organisationId: event.organisationId,
        messageType: "FLOWPAY_SETTLEMENT_READY",
        aggregateType: "SETTLEMENT",
        aggregateId: settlementId,
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          settlementId,
          sourceEventId: event.id,
          approvalMode: "AUTOMATIC",
        },
        createdAt: now,
      }),
    );
  }

  return { id: settlementId, state };
}

async function loadRules(
  database: D1Database,
  event: BusinessEvent<JsonValue>,
): Promise<readonly SettlementRuleVersion[]> {
  const rows = await database
    .prepare(
      `SELECT srv.id, srv.rule_id, srv.version, srv.trigger_event_type,
              srv.trigger_schema_version, srv.priority, srv.effective_from,
              srv.effective_to, srv.conditions_json, srv.beneficiaries_json,
              srv.provider_policy_json, srv.approval_policy_version_id
       FROM settlement_rule_versions srv
       JOIN settlement_rules sr ON sr.id = srv.rule_id
       WHERE sr.organisation_id = ? AND sr.status = 'ACTIVE'
         AND srv.trigger_event_type = ? AND srv.trigger_schema_version = ?`,
    )
    .bind(event.organisationId, event.eventType, event.schemaVersion)
    .all<SettlementRuleRow>();
  try {
    return rows.results.map(parseSettlementRuleRow);
  } catch (error) {
    if (error instanceof StoredConfigurationError) {
      throw new FlowPayConfigurationError(error.message);
    }
    throw error;
  }
}

async function validateBeneficiaries(
  database: D1Database,
  organisationId: string,
  beneficiaryIds: readonly string[],
): Promise<void> {
  const statements = beneficiaryIds.map((beneficiaryId) =>
    database
      .prepare(
        "SELECT id, status FROM participants WHERE organisation_id = ? AND id = ?",
      )
      .bind(organisationId, beneficiaryId),
  );
  const results = await database.batch<ParticipantRow>(statements);
  for (const [index, result] of results.entries()) {
    const beneficiaryId = beneficiaryIds[index];
    const row = result.results[0];
    if (!row || row.id !== beneficiaryId || row.status !== "ACTIVE") {
      throw new FlowPayConfigurationError(
        `Beneficiary ${beneficiaryId ?? "unknown"} is not active for the organisation.`,
      );
    }
  }
}

async function findExistingEvent(
  database: D1Database,
  event: Pick<
    BusinessEvent<JsonValue>,
    "organisationId" | "source" | "externalEventId"
  >,
): Promise<ExistingEventRow | null> {
  return database
    .prepare(
      `SELECT be.id AS event_id, be.deduplication_hash,
              re.id AS evaluation_id, re.outcome AS evaluation_outcome,
              s.id AS settlement_id, s.state AS settlement_state
       FROM business_events be
       LEFT JOIN rule_evaluations re ON re.business_event_id = be.id
       LEFT JOIN settlements s ON s.source_event_id = be.id
       WHERE be.organisation_id = ? AND be.source = ? AND be.external_event_id = ?`,
    )
    .bind(event.organisationId, event.source, event.externalEventId)
    .first<ExistingEventRow>();
}

function replay(
  existing: ExistingEventRow,
  requestedHash: string,
): RecordBusinessEventResult {
  if (existing.deduplication_hash !== requestedHash) {
    throw new EventReplayConflictError(
      "The event identity was already used for different business data.",
    );
  }
  if (!existing.evaluation_id || !existing.evaluation_outcome) {
    throw new FlowPayConfigurationError(
      "The existing business event has no completed rule evaluation.",
    );
  }
  return {
    replayed: true,
    eventId: existing.event_id,
    evaluationId: existing.evaluation_id,
    outcome: existing.evaluation_outcome,
    ...(existing.settlement_id && existing.settlement_state
      ? {
          settlement: {
            id: existing.settlement_id,
            state: existing.settlement_state,
          },
        }
      : {}),
  };
}

function selectionEvidence(
  selection: ReturnType<typeof selectSettlementRule>,
): JsonValue {
  return {
    outcome: selection.outcome,
    ...(selection.outcome === "MATCHED"
      ? { matchedRuleVersionId: selection.rule.id }
      : {}),
    ...(selection.outcome === "CONFLICT"
      ? {
          priority: selection.priority,
          conflictingRuleVersionIds: selection.conflictingRuleVersionIds,
        }
      : {}),
    evaluations: selection.evaluations,
  };
}

function isEventIdentityConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed: business_events.")
  );
}

function requireIdentifier(label: string, value: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty trimmed string.`);
  }
}
