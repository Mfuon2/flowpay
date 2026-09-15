import { canonicalJson, hashCanonicalJson } from "../flowpay/canonical-json.ts";
import { auditStatement } from "../flowpay/evidence-statements.ts";

export type ResolveReconciliationCommand = Readonly<{
  resolutionId: string;
  organisationId: string;
  reconciliationId: string;
  actorId: string;
  correlationId: string;
  reason: string;
  evidenceReference: string;
  resolvedAt: string;
}>;

type Existing = Readonly<{
  reconciliation_id: string;
  command_fingerprint: string;
}>;

export class ReconciliationResolutionConflictError extends Error {
  override readonly name = "ReconciliationResolutionConflictError";
}

export class ReconciliationResolutionUnavailableError extends Error {
  override readonly name = "ReconciliationResolutionUnavailableError";
}

export async function resolveReconciliation(
  database: D1Database,
  command: ResolveReconciliationCommand,
) {
  const normalized = {
    resolutionId: required("Resolution ID", command.resolutionId),
    organisationId: required("Organisation ID", command.organisationId),
    reconciliationId: required("Reconciliation ID", command.reconciliationId),
    actorId: required("Actor ID", command.actorId),
    correlationId: required("Correlation ID", command.correlationId),
    reason: required("Resolution reason", command.reason),
    evidenceReference: required(
      "Resolution evidence reference",
      command.evidenceReference,
    ),
    resolvedAt: timestamp(command.resolvedAt),
  };
  const fingerprint = await hashCanonicalJson(normalized);
  const existing = await findExisting(database, normalized.resolutionId);
  if (existing) return replay(existing, normalized, fingerprint);
  const reconciliation = await database
    .prepare(
      `SELECT id FROM reconciliation_records
       WHERE id = ? AND organisation_id = ? AND status = 'MISMATCHED'
         AND NOT EXISTS (
           SELECT 1 FROM reconciliation_resolutions resolution
           WHERE resolution.reconciliation_id = reconciliation_records.id
         )`,
    )
    .bind(normalized.reconciliationId, normalized.organisationId)
    .first<string>("id");
  if (!reconciliation) {
    throw new ReconciliationResolutionUnavailableError(
      "Only an unresolved reconciliation mismatch can be resolved.",
    );
  }
  const resolution = {
    resolutionId: normalized.resolutionId,
    actorId: normalized.actorId,
    reason: normalized.reason,
    evidenceReference: normalized.evidenceReference,
    resolvedAt: normalized.resolvedAt,
  };
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO reconciliation_resolutions (
            id, organisation_id, reconciliation_id, actor_id, reason,
            evidence_reference, command_fingerprint, resolved_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          normalized.resolutionId,
          normalized.organisationId,
          normalized.reconciliationId,
          normalized.actorId,
          normalized.reason,
          normalized.evidenceReference,
          fingerprint,
          normalized.resolvedAt,
        ),
      database
        .prepare(
          `UPDATE reconciliation_records
           SET status = 'RESOLVED', resolution_json = ?, updated_at = ?
           WHERE id = ? AND organisation_id = ? AND status = 'MISMATCHED'`,
        )
        .bind(
          canonicalJson(resolution),
          normalized.resolvedAt,
          normalized.reconciliationId,
          normalized.organisationId,
        ),
      auditStatement(database, {
        id: crypto.randomUUID(),
        organisationId: normalized.organisationId,
        actorType: "USER",
        actorId: normalized.actorId,
        action: "RECONCILIATION_RESOLVED",
        aggregateType: "RECONCILIATION",
        aggregateId: normalized.reconciliationId,
        correlationId: normalized.correlationId,
        causationId: normalized.resolutionId,
        evidence: resolution,
        occurredAt: normalized.resolvedAt,
      }),
    ]);
  } catch (error) {
    const raced = await findExisting(database, normalized.resolutionId);
    if (raced) return replay(raced, normalized, fingerprint);
    throw error;
  }
  return {
    reconciliationId: normalized.reconciliationId,
    resolutionId: normalized.resolutionId,
    status: "RESOLVED" as const,
    replayed: false,
  };
}

async function findExisting(database: D1Database, id: string) {
  return database
    .prepare(
      `SELECT reconciliation_id, command_fingerprint
       FROM reconciliation_resolutions WHERE id = ?`,
    )
    .bind(id)
    .first<Existing>();
}

function replay(
  existing: Existing,
  command: ResolveReconciliationCommand,
  fingerprint: string,
) {
  if (
    existing.reconciliation_id !== command.reconciliationId ||
    existing.command_fingerprint !== fingerprint
  ) {
    throw new ReconciliationResolutionConflictError(
      "Resolution identity was reused for different evidence.",
    );
  }
  return {
    reconciliationId: command.reconciliationId,
    resolutionId: command.resolutionId,
    status: "RESOLVED" as const,
    replayed: true,
  };
}

function required(label: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} is required.`);
  if (normalized.length > 500) throw new TypeError(`${label} is too long.`);
  return normalized;
}

function timestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || !value.endsWith("Z")) {
    throw new TypeError("Resolution time must be a UTC timestamp.");
  }
  return value;
}
