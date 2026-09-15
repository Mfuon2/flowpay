import type { SettlementProvider } from "@flowpay/provider-contract";

import { observeProviderTransaction } from "./observe-provider-transaction.ts";

export type ProviderObservationBatchResult = Readonly<{
  selected: number;
  confirmed: number;
  pending: number;
  failed: number;
  notFound: number;
  errored: number;
}>;

type Candidate = Readonly<{
  id: string;
  observation_attempts: number;
}>;

export async function processDueProviderObservations(
  database: D1Database,
  providerKey: string,
  provider: SettlementProvider,
  options: Readonly<{
    now?: string;
    limit?: number;
    organisationId?: string;
  }> = {},
): Promise<ProviderObservationBatchResult> {
  const now = timestamp(options.now ?? new Date().toISOString());
  const limit = options.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("Provider observation limit must be from 1 to 100.");
  }
  const rows = await database
    .prepare(
      `SELECT spt.id, spt.observation_attempts
       FROM settlement_provider_transactions spt
       JOIN settlement_attempts sa ON sa.id = spt.settlement_attempt_id
       JOIN settlement_distributions sd ON sd.id = sa.settlement_distribution_id
       JOIN settlements s ON s.id = sd.settlement_id
       WHERE spt.provider = ? AND spt.provider_transaction_id IS NOT NULL
         AND spt.status = 'PENDING'
         AND s.state IN ('SUBMITTING', 'SUBMITTED')
         AND (spt.next_observation_at IS NULL OR spt.next_observation_at <= ?)
         AND (? IS NULL OR s.organisation_id = ?)
       ORDER BY COALESCE(spt.next_observation_at, spt.updated_at), spt.id
       LIMIT ?`,
    )
    .bind(
      providerKey,
      now,
      options.organisationId ?? null,
      options.organisationId ?? null,
      limit,
    )
    .all<Candidate>();

  const result = {
    selected: rows.results.length,
    confirmed: 0,
    pending: 0,
    failed: 0,
    notFound: 0,
    errored: 0,
  };
  for (const candidate of rows.results) {
    const leaseUntil = addSeconds(now, 60);
    const claim = await database
      .prepare(
        `UPDATE settlement_provider_transactions
         SET observation_attempts = observation_attempts + 1,
             next_observation_at = ?, last_observation_error = NULL
         WHERE id = ? AND status = 'PENDING'
           AND (next_observation_at IS NULL OR next_observation_at <= ?)`,
      )
      .bind(leaseUntil, candidate.id, now)
      .run();
    if (claim.meta.changes !== 1) continue;
    try {
      const observation = await observeProviderTransaction(
        database,
        candidate.id,
        providerKey,
        provider,
      );
      if (observation.outcome === "CONFIRMED") result.confirmed += 1;
      else if (observation.outcome === "FAILED") result.failed += 1;
      else if (observation.outcome === "NOT_FOUND") result.notFound += 1;
      else result.pending += 1;
      const next =
        observation.outcome === "CONFIRMED" || observation.outcome === "FAILED"
          ? null
          : addSeconds(
              now,
              observationDelay(candidate.observation_attempts + 1),
            );
      await database
        .prepare(
          `UPDATE settlement_provider_transactions
           SET next_observation_at = ?, last_observation_error = NULL
           WHERE id = ?`,
        )
        .bind(next, candidate.id)
        .run();
    } catch (error) {
      result.errored += 1;
      await database
        .prepare(
          `UPDATE settlement_provider_transactions
           SET next_observation_at = ?, last_observation_error = ?
           WHERE id = ? AND status = 'PENDING'`,
        )
        .bind(
          addSeconds(now, observationDelay(candidate.observation_attempts + 1)),
          safeError(error),
          candidate.id,
        )
        .run();
    }
  }
  return result;
}

function observationDelay(attempt: number): number {
  return Math.min(30 * 2 ** Math.min(Math.max(attempt - 1, 0), 7), 3600);
}

function addSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1000).toISOString();
}

function timestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError("Provider observation time must be ISO 8601.");
  }
  return value;
}

function safeError(error: unknown): string {
  return (
    error instanceof Error ? error.message : "Unknown provider error"
  ).slice(0, 500);
}
