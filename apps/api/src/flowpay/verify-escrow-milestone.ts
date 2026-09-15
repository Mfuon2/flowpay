import type { JsonValue } from "@flowpay/domain";

import { canonicalJson, hashCanonicalJson } from "./canonical-json.ts";
import { auditStatement } from "./evidence-statements.ts";
import { recordBusinessEvent } from "./process-business-event.ts";

export type VerifyEscrowMilestoneCommand = Readonly<{
  verificationId: string;
  organisationId: string;
  escrowId: string;
  milestoneId: string;
  actorId: string;
  correlationId: string;
  evidence: JsonValue;
  verifiedAt: string;
}>;

type MilestoneContext = Readonly<{
  escrow_state: "FUNDED" | "PARTIALLY_RELEASED";
  position: number;
  name: string;
  verification_event_type: string;
  asset_code: string;
  release_amount_atomic: string;
  asset_scale: number;
  funding_payment_id: string;
}>;

type Existing = Readonly<{
  escrow_milestone_id: string;
  business_event_id: string;
  command_fingerprint: string;
}>;

export class EscrowVerificationConflictError extends Error {
  override readonly name = "EscrowVerificationConflictError";
}

export class EscrowVerificationUnavailableError extends Error {
  override readonly name = "EscrowVerificationUnavailableError";
}

export async function verifyEscrowMilestone(
  database: D1Database,
  command: VerifyEscrowMilestoneCommand,
) {
  const normalized = {
    verificationId: required("Verification ID", command.verificationId),
    organisationId: required("Organisation ID", command.organisationId),
    escrowId: required("Escrow ID", command.escrowId),
    milestoneId: required("Milestone ID", command.milestoneId),
    actorId: required("Actor ID", command.actorId),
    correlationId: required("Correlation ID", command.correlationId),
    evidence: command.evidence,
    verifiedAt: timestamp(command.verifiedAt),
  };
  const fingerprint = await hashCanonicalJson(normalized);
  const existing = await findExisting(database, normalized.verificationId);
  if (existing) return replay(existing, normalized, fingerprint, database);
  const milestone = await database
    .prepare(
      `SELECT ea.state AS escrow_state, em.position, em.name,
              em.verification_event_type, em.asset_code,
              em.release_amount_atomic, em.asset_scale, ea.funding_payment_id
       FROM escrow_milestones em
       JOIN escrow_arrangements ea ON ea.id = em.escrow_arrangement_id
       WHERE em.id = ? AND ea.id = ? AND ea.organisation_id = ?
         AND ea.state IN ('FUNDED', 'PARTIALLY_RELEASED')
         AND NOT EXISTS (
           SELECT 1 FROM escrow_milestone_verifications emv
           WHERE emv.escrow_milestone_id = em.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM escrow_milestones prior
           WHERE prior.escrow_arrangement_id = ea.id AND prior.position < em.position
             AND NOT EXISTS (
               SELECT 1 FROM escrow_milestone_verifications pv
               WHERE pv.escrow_milestone_id = prior.id
             )
         )`,
    )
    .bind(
      normalized.milestoneId,
      normalized.escrowId,
      normalized.organisationId,
    )
    .first<MilestoneContext>();
  if (!milestone) {
    throw new EscrowVerificationUnavailableError(
      "Milestone is unavailable, out of sequence, or escrow is not funded.",
    );
  }
  const event = await recordBusinessEvent(database, {
    event: {
      id: `event:${normalized.verificationId}`,
      organisationId: normalized.organisationId,
      source: "qesuite.escrow",
      externalEventId: normalized.verificationId,
      eventType: milestone.verification_event_type,
      schemaVersion: 1,
      aggregateType: "ESCROW_MILESTONE",
      aggregateId: normalized.milestoneId,
      occurredAt: normalized.verifiedAt,
      recordedAt: new Date().toISOString(),
      correlationId: normalized.correlationId,
      causationId: normalized.verificationId,
      payload: {
        escrowId: normalized.escrowId,
        milestoneId: normalized.milestoneId,
        position: milestone.position,
        evidence: normalized.evidence,
      },
    },
    facts: {
      "escrow.state": milestone.escrow_state,
      "escrow.milestone.position": String(milestone.position),
      "escrow.milestone.name": milestone.name,
      "escrow.funding.status": "CONFIRMED",
    },
    settlementAmount: {
      assetCode: milestone.asset_code,
      atomicAmount: milestone.release_amount_atomic,
      scale: milestone.asset_scale,
    },
    initiatedBy: "escrow-milestone-adapter",
  });
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO escrow_milestone_verifications (
            id, escrow_milestone_id, business_event_id, verified_by,
            evidence_json, verified_at, command_fingerprint
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          normalized.verificationId,
          normalized.milestoneId,
          event.eventId,
          normalized.actorId,
          canonicalJson(normalized.evidence),
          normalized.verifiedAt,
          fingerprint,
        ),
      auditStatement(database, {
        id: crypto.randomUUID(),
        organisationId: normalized.organisationId,
        actorType: "USER",
        actorId: normalized.actorId,
        action: "ESCROW_MILESTONE_VERIFIED",
        aggregateType: "ESCROW_MILESTONE",
        aggregateId: normalized.milestoneId,
        correlationId: normalized.correlationId,
        causationId: normalized.verificationId,
        evidence: {
          escrowId: normalized.escrowId,
          businessEventId: event.eventId,
          ruleOutcome: event.outcome,
          settlementId: event.settlement?.id ?? null,
        },
        occurredAt: normalized.verifiedAt,
      }),
    ]);
  } catch (error) {
    const raced = await findExisting(database, normalized.verificationId);
    if (raced) return replay(raced, normalized, fingerprint, database);
    throw error;
  }
  return {
    verificationId: normalized.verificationId,
    eventId: event.eventId,
    ruleOutcome: event.outcome,
    settlementId: event.settlement?.id ?? null,
    replayed: false,
  };
}

async function replay(
  existing: Existing,
  command: VerifyEscrowMilestoneCommand,
  fingerprint: string,
  database: D1Database,
) {
  if (
    existing.escrow_milestone_id !== command.milestoneId ||
    existing.command_fingerprint !== fingerprint
  ) {
    throw new EscrowVerificationConflictError(
      "Milestone verification identity was reused for different evidence.",
    );
  }
  const evaluation = await database
    .prepare(
      `SELECT re.outcome, s.id AS settlement_id
       FROM rule_evaluations re
       LEFT JOIN settlements s ON s.source_event_id = re.business_event_id
       WHERE re.business_event_id = ?`,
    )
    .bind(existing.business_event_id)
    .first<{
      outcome: "NO_MATCH" | "MATCHED" | "CONFLICT";
      settlement_id: string | null;
    }>();
  if (!evaluation)
    throw new EscrowVerificationUnavailableError(
      "Verification evaluation is missing.",
    );
  return {
    verificationId: command.verificationId,
    eventId: existing.business_event_id,
    ruleOutcome: evaluation.outcome,
    settlementId: evaluation.settlement_id,
    replayed: true,
  };
}

async function findExisting(
  database: D1Database,
  id: string,
): Promise<Existing | null> {
  return database
    .prepare(
      `SELECT escrow_milestone_id, business_event_id, command_fingerprint
     FROM escrow_milestone_verifications WHERE id = ?`,
    )
    .bind(id)
    .first<Existing>();
}
function required(label: string, value: string) {
  const result = value.trim();
  if (!result) throw new TypeError(`${label} is required.`);
  return result;
}
function timestamp(value: string) {
  if (!Number.isFinite(Date.parse(value)))
    throw new TypeError("Verification time must be ISO 8601.");
  return value;
}
