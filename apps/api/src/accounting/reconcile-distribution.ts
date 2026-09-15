import { hashCanonicalJson } from "../flowpay/canonical-json.ts";
import {
  auditStatement,
  outboxStatement,
} from "../flowpay/evidence-statements.ts";

export type ReconcileDistributionCommand = Readonly<{
  reconciliationId: string;
  organisationId: string;
  distributionId: string;
  providerTransactionRecordId: string;
  journalEntryId: string;
  journalLineId: string;
  correlationId: string;
  actorId: string;
}>;

export type ReconcileDistributionResult = Readonly<{
  reconciliationId: string;
  status: "MATCHED" | "MISMATCHED";
  replayed: boolean;
  checks: Readonly<Record<string, boolean>>;
}>;

export class ReconciliationConflictError extends Error {
  override readonly name = "ReconciliationConflictError";
}

export class ReconciliationUnavailableError extends Error {
  override readonly name = "ReconciliationUnavailableError";
}

type ReconciliationFacts = Readonly<{
  distribution_id: string;
  distribution_state: string;
  distribution_asset_code: string;
  distribution_amount_atomic: string;
  distribution_asset_scale: number;
  settlement_organisation_id: string;
  provider_transaction_record_id: string | null;
  provider_status: string | null;
  provider_transaction_id: string | null;
  network_transaction_reference: string | null;
  provider_distribution_id: string | null;
  journal_entry_id: string | null;
  journal_status: string | null;
  journal_line_id: string | null;
  journal_direction: string | null;
  journal_asset_code: string | null;
  journal_amount_atomic: string | null;
  journal_asset_scale: number | null;
}>;

type ExistingReconciliation = Readonly<{
  id: string;
  status: "MATCHED" | "MISMATCHED";
  reconciliation_fingerprint: string;
  evidence_json: string;
}>;

export async function reconcileDistribution(
  database: D1Database,
  command: ReconcileDistributionCommand,
): Promise<ReconcileDistributionResult> {
  validateCommand(command);
  const fingerprint = await hashCanonicalJson(command);
  const existing = await findExisting(database, command.distributionId);
  if (existing) return replay(existing, fingerprint);

  const facts = await loadFacts(database, command);
  if (facts.settlement_organisation_id !== command.organisationId) {
    throw new ReconciliationUnavailableError(
      "The distribution was not found in the organisation.",
    );
  }
  const checks = {
    distributionConfirmed: facts.distribution_state === "CONFIRMED",
    providerBelongsToDistribution:
      facts.provider_distribution_id === facts.distribution_id,
    providerConfirmed: facts.provider_status === "CONFIRMED",
    providerReferencePresent:
      typeof facts.provider_transaction_id === "string" &&
      facts.provider_transaction_id.length > 0,
    networkReferencePresent:
      typeof facts.network_transaction_reference === "string" &&
      facts.network_transaction_reference.length > 0,
    journalPosted: facts.journal_status === "POSTED",
    lineBelongsToJournal: facts.journal_line_id !== null,
    lineIsDebit: facts.journal_direction === "DEBIT",
    assetMatches:
      facts.journal_asset_code === facts.distribution_asset_code &&
      facts.journal_asset_scale === facts.distribution_asset_scale,
    amountMatches:
      facts.journal_amount_atomic === facts.distribution_amount_atomic,
  } as const;
  const status = Object.values(checks).every(Boolean)
    ? "MATCHED"
    : "MISMATCHED";
  const now = new Date().toISOString();
  const evidence = {
    checks,
    expected: {
      assetCode: facts.distribution_asset_code,
      atomicAmount: facts.distribution_amount_atomic,
      scale: facts.distribution_asset_scale,
    },
    providerTransactionId: facts.provider_transaction_id,
    networkTransactionReference: facts.network_transaction_reference,
    journalLine: {
      direction: facts.journal_direction,
      assetCode: facts.journal_asset_code,
      atomicAmount: facts.journal_amount_atomic,
      scale: facts.journal_asset_scale,
    },
  };
  const statements = [
    database
      .prepare(
        `INSERT INTO reconciliation_records (
          id, organisation_id, settlement_distribution_id,
          provider_transaction_id, journal_entry_id, status, evidence_json,
          created_at, updated_at, journal_line_id,
          reconciliation_fingerprint, checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        command.reconciliationId,
        command.organisationId,
        command.distributionId,
        command.providerTransactionRecordId,
        command.journalEntryId,
        status,
        JSON.stringify(evidence),
        now,
        now,
        command.journalLineId,
        fingerprint,
        now,
      ),
    auditStatement(database, {
      id: crypto.randomUUID(),
      organisationId: command.organisationId,
      actorType: "SERVICE",
      actorId: command.actorId,
      action:
        status === "MATCHED"
          ? "DISTRIBUTION_RECONCILED"
          : "DISTRIBUTION_RECONCILIATION_MISMATCH",
      aggregateType: "SETTLEMENT_DISTRIBUTION",
      aggregateId: command.distributionId,
      correlationId: command.correlationId,
      causationId: command.reconciliationId,
      evidence,
      occurredAt: now,
    }),
    outboxStatement(database, {
      id: crypto.randomUUID(),
      organisationId: command.organisationId,
      messageType: "ACCOUNTING_RECONCILIATION_COMPLETED",
      aggregateType: "SETTLEMENT_DISTRIBUTION",
      aggregateId: command.distributionId,
      correlationId: command.correlationId,
      causationId: command.reconciliationId,
      payload: {
        reconciliationId: command.reconciliationId,
        distributionId: command.distributionId,
        status,
      },
      createdAt: now,
    }),
  ];
  try {
    await database.batch(statements);
  } catch (error) {
    const concurrent = await findExisting(database, command.distributionId);
    if (concurrent) return replay(concurrent, fingerprint);
    throw error;
  }
  return {
    reconciliationId: command.reconciliationId,
    status,
    replayed: false,
    checks,
  };
}

async function loadFacts(
  database: D1Database,
  command: ReconcileDistributionCommand,
): Promise<ReconciliationFacts> {
  const facts = await database
    .prepare(
      `SELECT sd.id AS distribution_id, sd.state AS distribution_state,
              sd.asset_code AS distribution_asset_code,
              sd.amount_atomic AS distribution_amount_atomic,
              sd.asset_scale AS distribution_asset_scale,
              s.organisation_id AS settlement_organisation_id,
              spt.id AS provider_transaction_record_id,
              spt.status AS provider_status,
              spt.provider_transaction_id,
              spt.network_transaction_reference,
              provider_sd.id AS provider_distribution_id,
              je.id AS journal_entry_id, je.status AS journal_status,
              jl.id AS journal_line_id, jl.direction AS journal_direction,
              jl.asset_code AS journal_asset_code,
              jl.amount_atomic AS journal_amount_atomic,
              jl.asset_scale AS journal_asset_scale
       FROM settlement_distributions sd
       JOIN settlements s ON s.id = sd.settlement_id
       LEFT JOIN settlement_provider_transactions spt ON spt.id = ?
       LEFT JOIN settlement_attempts sa ON sa.id = spt.settlement_attempt_id
       LEFT JOIN settlement_distributions provider_sd
         ON provider_sd.id = sa.settlement_distribution_id
       LEFT JOIN journal_entries je ON je.id = ?
         AND je.organisation_id = s.organisation_id
       LEFT JOIN journal_lines jl ON jl.id = ?
         AND jl.journal_entry_id = je.id
       WHERE sd.id = ?`,
    )
    .bind(
      command.providerTransactionRecordId,
      command.journalEntryId,
      command.journalLineId,
      command.distributionId,
    )
    .first<ReconciliationFacts>();
  if (!facts) {
    throw new ReconciliationUnavailableError("The distribution was not found.");
  }
  return facts;
}

async function findExisting(
  database: D1Database,
  distributionId: string,
): Promise<ExistingReconciliation | null> {
  return database
    .prepare(
      `SELECT id, status, reconciliation_fingerprint, evidence_json
       FROM reconciliation_records WHERE settlement_distribution_id = ?`,
    )
    .bind(distributionId)
    .first<ExistingReconciliation>();
}

function replay(
  existing: ExistingReconciliation,
  fingerprint: string,
): ReconcileDistributionResult {
  if (existing.reconciliation_fingerprint !== fingerprint) {
    throw new ReconciliationConflictError(
      "The distribution already has reconciliation evidence for different inputs.",
    );
  }
  const evidence = JSON.parse(existing.evidence_json) as {
    checks: Record<string, boolean>;
  };
  return {
    reconciliationId: existing.id,
    status: existing.status,
    replayed: true,
    checks: evidence.checks,
  };
}

function validateCommand(command: ReconcileDistributionCommand): void {
  for (const [label, value] of [
    ["Reconciliation ID", command.reconciliationId],
    ["Organisation ID", command.organisationId],
    ["Distribution ID", command.distributionId],
    ["Provider transaction record ID", command.providerTransactionRecordId],
    ["Journal entry ID", command.journalEntryId],
    ["Journal line ID", command.journalLineId],
    ["Correlation ID", command.correlationId],
    ["Actor ID", command.actorId],
  ] as const) {
    if (value.length === 0 || value !== value.trim()) {
      throw new TypeError(`${label} must be a trimmed value.`);
    }
  }
}
