import { auditStatement } from "./evidence-statements.ts";

type Context = Readonly<{
  organisation_id: string;
  settlement_id: string;
  milestone_id: string;
  escrow_id: string;
  escrow_state: "FUNDED" | "PARTIALLY_RELEASED";
  state_version: number;
  correlation_id: string;
  total_milestones: number;
  released_milestones: number;
}>;

export async function processEscrowSettlementConfirmed(
  database: D1Database,
  settlementId: string,
): Promise<"NOT_ESCROW" | "RELEASED" | "ALREADY_RELEASED"> {
  const existing = await database
    .prepare("SELECT id FROM escrow_milestone_releases WHERE settlement_id = ?")
    .bind(settlementId)
    .first<string>("id");
  if (existing) return "ALREADY_RELEASED";
  const context = await database
    .prepare(
      `SELECT s.organisation_id, s.id AS settlement_id,
            em.id AS milestone_id, ea.id AS escrow_id,
            ea.state AS escrow_state, ea.state_version, be.correlation_id,
            (SELECT COUNT(*) FROM escrow_milestones allm
             WHERE allm.escrow_arrangement_id = ea.id) AS total_milestones,
            (SELECT COUNT(*) FROM escrow_milestone_releases allr
             JOIN escrow_milestones released ON released.id = allr.escrow_milestone_id
             WHERE released.escrow_arrangement_id = ea.id) AS released_milestones
     FROM settlements s
     JOIN business_events be ON be.id = s.source_event_id
     JOIN escrow_milestone_verifications emv ON emv.business_event_id = be.id
     JOIN escrow_milestones em ON em.id = emv.escrow_milestone_id
     JOIN escrow_arrangements ea ON ea.id = em.escrow_arrangement_id
     WHERE s.id = ? AND s.state = 'CONFIRMED'
       AND ea.state IN ('FUNDED', 'PARTIALLY_RELEASED')`,
    )
    .bind(settlementId)
    .first<Context>();
  if (!context) return "NOT_ESCROW";
  const final = context.released_milestones + 1 === context.total_milestones;
  const nextState = final ? "RELEASED" : "PARTIALLY_RELEASED";
  const action = final ? "RELEASE_FINAL" : "RELEASE_PARTIAL";
  const now = new Date().toISOString();
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO escrow_milestone_releases (
          id, escrow_milestone_id, settlement_id, released_at
        ) VALUES (?, ?, ?, ?)`,
        )
        .bind(
          `escrow-release:${settlementId}`,
          context.milestone_id,
          settlementId,
          now,
        ),
      database
        .prepare(
          `INSERT INTO escrow_state_transitions (
          id, organisation_id, escrow_arrangement_id, from_state, to_state,
          from_version, to_version, action, actor_type, actor_id,
          correlation_id, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SERVICE',
                  'escrow-release-orchestrator', ?, ?)`,
        )
        .bind(
          `escrow-transition:${settlementId}`,
          context.organisation_id,
          context.escrow_id,
          context.escrow_state,
          nextState,
          context.state_version,
          context.state_version + 1,
          action,
          context.correlation_id,
          now,
        ),
      database
        .prepare(
          `UPDATE escrow_arrangements SET state = ?, state_version = ?, updated_at = ?
         WHERE id = ? AND state = ? AND state_version = ?`,
        )
        .bind(
          nextState,
          context.state_version + 1,
          now,
          context.escrow_id,
          context.escrow_state,
          context.state_version,
        ),
      auditStatement(database, {
        id: crypto.randomUUID(),
        organisationId: context.organisation_id,
        actorType: "SERVICE",
        actorId: "escrow-release-orchestrator",
        action: "ESCROW_MILESTONE_RELEASED",
        aggregateType: "ESCROW_MILESTONE",
        aggregateId: context.milestone_id,
        correlationId: context.correlation_id,
        causationId: settlementId,
        evidence: {
          escrowId: context.escrow_id,
          settlementId,
          final,
          nextState,
        },
        occurredAt: now,
      }),
    ]);
  } catch (error) {
    const raced = await database
      .prepare(
        "SELECT id FROM escrow_milestone_releases WHERE settlement_id = ?",
      )
      .bind(settlementId)
      .first<string>("id");
    if (raced) return "ALREADY_RELEASED";
    throw error;
  }
  return "RELEASED";
}
