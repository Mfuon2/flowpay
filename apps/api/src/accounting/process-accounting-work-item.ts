import { postJournal } from "./post-journal.ts";
import { reconcileDistribution } from "./reconcile-distribution.ts";

export type ProcessAccountingWorkItemResult = Readonly<{
  workItemId: string;
  settlementId: string;
  journalEntryId: string;
  reconciliationCount: number;
  outcome: "COMPLETED" | "ALREADY_COMPLETED" | "MISMATCHED";
}>;

export class AccountingWorkUnavailableError extends Error {
  override readonly name = "AccountingWorkUnavailableError";
}

type WorkContext = Readonly<{
  work_item_id: string;
  work_status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  organisation_id: string;
  settlement_id: string;
  settlement_state: string;
  amount_atomic: string;
  asset_code: string;
  asset_scale: number;
  effective_at: string;
  correlation_id: string;
  journal_entry_id: string | null;
}>;

type PolicyRow = Readonly<{
  id: string;
  priority: number;
  policy_json: string;
}>;

type CashMovementPolicy = Readonly<{
  kind: "SETTLEMENT_CASH_MOVEMENT_V1";
  assetCode: string;
  scale: number;
  distributionDebitAccountId: string;
  cashCreditAccountId: string;
  beneficiaryDebitAccounts: readonly Readonly<{
    beneficiaryId: string;
    accountId: string;
  }>[];
}>;

type DistributionRow = Readonly<{
  id: string;
  position: number;
  beneficiary_id: string;
  amount_atomic: string;
  provider_transaction_record_id: string | null;
}>;

export async function processAccountingWorkItem(
  database: D1Database,
  workItemId: string,
): Promise<ProcessAccountingWorkItemResult> {
  const context = await loadContext(database, workItemId);
  if (context.work_status === "COMPLETED") {
    if (!context.journal_entry_id) {
      throw new AccountingWorkUnavailableError(
        "Completed accounting work has no journal reference.",
      );
    }
    const count = await reconciliationCount(database, context.settlement_id);
    return response(
      context,
      context.journal_entry_id,
      count,
      "ALREADY_COMPLETED",
    );
  }
  if (context.work_status === "FAILED") {
    throw new AccountingWorkUnavailableError(
      "Accounting work requires an explicit recovery decision.",
    );
  }
  if (context.settlement_state !== "CONFIRMED") {
    throw new AccountingWorkUnavailableError(
      "Accounting work requires a confirmed settlement.",
    );
  }
  const policyRow = await selectPolicy(database, context);
  const policy = parsePolicy(policyRow.policy_json);
  if (
    policy.assetCode !== context.asset_code ||
    policy.scale !== context.asset_scale
  ) {
    throw new AccountingWorkUnavailableError(
      "The accounting policy asset precision does not match the settlement.",
    );
  }
  const distributions = await loadDistributions(
    database,
    context.settlement_id,
  );
  if (
    distributions.length === 0 ||
    distributions.some(
      ({ provider_transaction_record_id }) =>
        provider_transaction_record_id === null,
    )
  ) {
    throw new AccountingWorkUnavailableError(
      "Every distribution requires one confirmed provider transaction.",
    );
  }

  const now = new Date().toISOString();
  await database
    .prepare(
      `UPDATE accounting_work_items
       SET status = 'PROCESSING', attempt_count = attempt_count + 1,
           posting_policy_version_id = ?, last_error = NULL, updated_at = ?
       WHERE id = ? AND status IN ('PENDING', 'PROCESSING')`,
    )
    .bind(policyRow.id, now, context.work_item_id)
    .run();

  const journalEntryId = `journal:settlement:${context.settlement_id}:cash-movement`;
  const beneficiaryDebitAccounts = new Map(
    policy.beneficiaryDebitAccounts.map((mapping) => [
      mapping.beneficiaryId,
      mapping.accountId,
    ]),
  );
  await postJournal(database, {
    postingId: journalEntryId,
    organisationId: context.organisation_id,
    sourceType: "SETTLEMENT",
    sourceId: context.settlement_id,
    postingPurpose: "SETTLEMENT_CASH_MOVEMENT",
    postingPolicyVersion: policyRow.id,
    effectiveAt: context.effective_at,
    correlationId: context.correlation_id,
    actorId: "accounting-orchestrator",
    lines: [
      ...distributions.map((distribution) => ({
        accountId:
          beneficiaryDebitAccounts.get(distribution.beneficiary_id) ??
          policy.distributionDebitAccountId,
        direction: "DEBIT" as const,
        amount: {
          assetCode: context.asset_code,
          atomicAmount: distribution.amount_atomic,
          scale: context.asset_scale,
        },
        memo: `Settlement distribution ${distribution.id}`,
      })),
      {
        accountId: policy.cashCreditAccountId,
        direction: "CREDIT",
        amount: {
          assetCode: context.asset_code,
          atomicAmount: context.amount_atomic,
          scale: context.asset_scale,
        },
        memo: `Settlement ${context.settlement_id} cash movement`,
      },
    ],
  });

  let mismatched = false;
  for (const distribution of distributions) {
    const reconciliation = await reconcileDistribution(database, {
      reconciliationId: `reconciliation:${distribution.id}`,
      organisationId: context.organisation_id,
      distributionId: distribution.id,
      providerTransactionRecordId:
        distribution.provider_transaction_record_id ?? "missing",
      journalEntryId,
      journalLineId: `${journalEntryId}:${distribution.position}`,
      correlationId: context.correlation_id,
      actorId: "accounting-orchestrator",
    });
    mismatched ||= reconciliation.status === "MISMATCHED";
  }
  const completedAt = new Date().toISOString();
  await database
    .prepare(
      `UPDATE accounting_work_items
       SET status = ?, journal_entry_id = ?, last_error = ?,
           completed_at = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(
      mismatched ? "FAILED" : "COMPLETED",
      journalEntryId,
      mismatched ? "One or more distributions did not reconcile." : null,
      completedAt,
      completedAt,
      context.work_item_id,
    )
    .run();
  return response(
    context,
    journalEntryId,
    distributions.length,
    mismatched ? "MISMATCHED" : "COMPLETED",
  );
}

async function selectPolicy(
  database: D1Database,
  context: WorkContext,
): Promise<PolicyRow> {
  const policies = await database
    .prepare(
      `SELECT appv.id, appv.priority, appv.policy_json
       FROM accounting_posting_policy_versions appv
       JOIN accounting_posting_policies app ON app.id = appv.policy_id
       WHERE app.organisation_id = ? AND app.status = 'ACTIVE'
         AND appv.trigger_event_type = 'FLOWPAY_SETTLEMENT_CONFIRMED'
         AND appv.effective_from <= ?
         AND (appv.effective_to IS NULL OR appv.effective_to > ?)
       ORDER BY appv.priority DESC, appv.id`,
    )
    .bind(context.organisation_id, context.effective_at, context.effective_at)
    .all<PolicyRow>();
  const selected = policies.results[0];
  if (!selected) {
    throw new AccountingWorkUnavailableError(
      "No effective accounting posting policy was found.",
    );
  }
  if (policies.results[1]?.priority === selected.priority) {
    throw new AccountingWorkUnavailableError(
      "Multiple accounting posting policies have the same highest priority.",
    );
  }
  return selected;
}

async function loadDistributions(
  database: D1Database,
  settlementId: string,
): Promise<readonly DistributionRow[]> {
  const rows = await database
    .prepare(
      `SELECT sd.id, sd.position, sd.beneficiary_id, sd.amount_atomic,
              spt.id AS provider_transaction_record_id
       FROM settlement_distributions sd
       LEFT JOIN settlement_attempts sa
         ON sa.settlement_distribution_id = sd.id AND sa.status = 'CONFIRMED'
       LEFT JOIN settlement_provider_transactions spt
         ON spt.settlement_attempt_id = sa.id AND spt.status = 'CONFIRMED'
       WHERE sd.settlement_id = ? AND sd.state = 'CONFIRMED'
       ORDER BY sd.position`,
    )
    .bind(settlementId)
    .all<DistributionRow>();
  const expected = await database
    .prepare(
      "SELECT COUNT(*) AS count FROM settlement_distributions WHERE settlement_id = ?",
    )
    .bind(settlementId)
    .first<number>("count");
  if (rows.results.length !== expected) return [];
  return rows.results;
}

async function loadContext(
  database: D1Database,
  workItemId: string,
): Promise<WorkContext> {
  const row = await database
    .prepare(
      `SELECT awi.id AS work_item_id, awi.status AS work_status,
              awi.organisation_id, awi.settlement_id, awi.journal_entry_id,
              s.state AS settlement_state, s.amount_atomic, s.asset_code,
              s.asset_scale, s.updated_at AS effective_at, be.correlation_id
       FROM accounting_work_items awi
       JOIN settlements s ON s.id = awi.settlement_id
       JOIN business_events be ON be.id = s.source_event_id
       WHERE awi.id = ?`,
    )
    .bind(workItemId)
    .first<WorkContext>();
  if (!row) {
    throw new AccountingWorkUnavailableError(
      "Accounting work item was not found.",
    );
  }
  return row;
}

async function reconciliationCount(
  database: D1Database,
  settlementId: string,
): Promise<number> {
  return (
    (await database
      .prepare(
        `SELECT COUNT(*) AS count FROM reconciliation_records rr
         JOIN settlement_distributions sd
           ON sd.id = rr.settlement_distribution_id
         WHERE sd.settlement_id = ?`,
      )
      .bind(settlementId)
      .first<number>("count")) ?? 0
  );
}

function parsePolicy(value: string): CashMovementPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new AccountingWorkUnavailableError(
      "Accounting posting policy is invalid JSON.",
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("kind" in parsed) ||
    parsed.kind !== "SETTLEMENT_CASH_MOVEMENT_V1" ||
    !("assetCode" in parsed) ||
    typeof parsed.assetCode !== "string" ||
    !("scale" in parsed) ||
    typeof parsed.scale !== "number" ||
    !Number.isSafeInteger(parsed.scale) ||
    !("distributionDebitAccountId" in parsed) ||
    typeof parsed.distributionDebitAccountId !== "string" ||
    !("cashCreditAccountId" in parsed) ||
    typeof parsed.cashCreditAccountId !== "string"
  ) {
    throw new AccountingWorkUnavailableError(
      "Accounting posting policy has an invalid shape.",
    );
  }
  const beneficiaryDebitAccounts = parseBeneficiaryDebitAccounts(parsed);
  return {
    kind: parsed.kind,
    assetCode: parsed.assetCode,
    scale: parsed.scale,
    distributionDebitAccountId: parsed.distributionDebitAccountId,
    cashCreditAccountId: parsed.cashCreditAccountId,
    beneficiaryDebitAccounts,
  };
}

function parseBeneficiaryDebitAccounts(
  parsed: Record<string, unknown>,
): CashMovementPolicy["beneficiaryDebitAccounts"] {
  if (!("beneficiaryDebitAccounts" in parsed)) return [];
  const values = unknownArray(parsed.beneficiaryDebitAccounts);
  if (!values) {
    throw new AccountingWorkUnavailableError(
      "Accounting beneficiary debit mappings must be an array.",
    );
  }
  const beneficiaryIds = new Set<string>();
  return values.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("beneficiaryId" in item) ||
      typeof item.beneficiaryId !== "string" ||
      !("accountId" in item) ||
      typeof item.accountId !== "string" ||
      beneficiaryIds.has(item.beneficiaryId)
    ) {
      throw new AccountingWorkUnavailableError(
        "Accounting beneficiary debit mapping has an invalid shape.",
      );
    }
    beneficiaryIds.add(item.beneficiaryId);
    return { beneficiaryId: item.beneficiaryId, accountId: item.accountId };
  });
}

function unknownArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item: unknown) => item);
}

function response(
  context: WorkContext,
  journalEntryId: string,
  reconciliationCountValue: number,
  outcome: ProcessAccountingWorkItemResult["outcome"],
): ProcessAccountingWorkItemResult {
  return {
    workItemId: context.work_item_id,
    settlementId: context.settlement_id,
    journalEntryId,
    reconciliationCount: reconciliationCountValue,
    outcome,
  };
}
