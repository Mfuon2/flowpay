import type { SettlementProvider } from "@flowpay/provider-contract";

import {
  executeSettlementWorkItem,
  type ExecuteSettlementWorkItemResult,
} from "./execute-settlement-work-item.ts";

export type DueSettlementWorkResult = Readonly<{
  selected: number;
  completed: number;
  deferred: number;
  failed: number;
}>;

type WorkItemRow = Readonly<{ id: string }>;

export async function processDueSettlementWork(
  database: D1Database,
  providerKey: string,
  provider: SettlementProvider,
  options: Readonly<{
    now?: string;
    limit?: number;
    organisationId?: string;
  }> = {},
): Promise<DueSettlementWorkResult> {
  if (providerKey.length === 0 || providerKey !== providerKey.trim()) {
    throw new TypeError("Provider key must be a non-empty trimmed string.");
  }
  const limit = options.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("Due settlement work limit must be from 1 to 100.");
  }
  const now = options.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) {
    throw new TypeError("Due settlement work time must be a timestamp.");
  }
  const rows = await database
    .prepare(
      `SELECT wi.id
       FROM settlement_work_items wi
       JOIN settlements s ON s.id = wi.settlement_id
       JOIN settlement_rule_versions srv ON srv.id = s.rule_version_id
       WHERE wi.status = 'PENDING'
         AND (wi.next_attempt_at IS NULL OR wi.next_attempt_at <= ?)
         AND s.state IN ('READY', 'SUBMITTING')
         AND json_extract(srv.provider_policy_json, '$.providerKey') = ?
         AND (? IS NULL OR wi.organisation_id = ?)
       ORDER BY COALESCE(wi.next_attempt_at, wi.created_at), wi.id
       LIMIT ?`,
    )
    .bind(
      now,
      providerKey,
      options.organisationId ?? null,
      options.organisationId ?? null,
      limit,
    )
    .all<WorkItemRow>();

  let completed = 0;
  let deferred = 0;
  let failed = 0;
  for (const row of rows.results) {
    try {
      const result = await executeSettlementWorkItem(
        database,
        row.id,
        providerKey,
        provider,
      );
      if (isCompleted(result)) completed += 1;
      else if (result.outcome === "RETRY_SCHEDULED") deferred += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      const retryAt = new Date(Date.parse(now) + 5 * 60_000).toISOString();
      const message = safeError(error);
      await database
        .prepare(
          `UPDATE settlement_work_items
           SET next_attempt_at = ?, last_error = ?, updated_at = ?
           WHERE id = ? AND status = 'PENDING'`,
        )
        .bind(retryAt, message, now, row.id)
        .run();
    }
  }
  return { selected: rows.results.length, completed, deferred, failed };
}

function isCompleted(result: ExecuteSettlementWorkItemResult): boolean {
  return (
    result.outcome === "CONFIRMED" ||
    result.outcome === "SUBMITTED" ||
    result.outcome === "ALREADY_COMPLETED"
  );
}

function safeError(error: unknown): string {
  return (
    error instanceof Error ? error.message : "Unknown execution error"
  ).slice(0, 500);
}
