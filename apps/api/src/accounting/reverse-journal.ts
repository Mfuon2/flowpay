import type { JournalLineDraft } from "@flowpay/accounting";

import { postJournal } from "./post-journal.ts";

export type ReverseJournalCommand = Readonly<{
  reversalId: string;
  organisationId: string;
  journalEntryId: string;
  actorId: string;
  correlationId: string;
  reason: string;
  evidenceReference: string;
  effectiveAt: string;
}>;

type Original = Readonly<{
  id: string;
  source_type: "BUSINESS_EVENT" | "SETTLEMENT" | "SETTLEMENT_DISTRIBUTION";
  source_id: string;
  posting_purpose: string;
  posting_policy_version: string;
}>;

type OriginalLine = Readonly<{
  ledger_account_id: string;
  direction: "DEBIT" | "CREDIT";
  asset_code: string;
  amount_atomic: string;
  asset_scale: number;
  memo: string | null;
}>;

export class JournalReversalUnavailableError extends Error {
  override readonly name = "JournalReversalUnavailableError";
}

export async function reverseJournal(
  database: D1Database,
  command: ReverseJournalCommand,
) {
  const normalized = {
    reversalId: required("Reversal ID", command.reversalId),
    organisationId: required("Organisation ID", command.organisationId),
    journalEntryId: required("Journal entry ID", command.journalEntryId),
    actorId: required("Actor ID", command.actorId),
    correlationId: required("Correlation ID", command.correlationId),
    reason: required("Reversal reason", command.reason),
    evidenceReference: required(
      "Reversal evidence reference",
      command.evidenceReference,
    ),
    effectiveAt: timestamp(command.effectiveAt),
  };
  const original = await database
    .prepare(
      `SELECT id, source_type, source_id, posting_purpose,
              posting_policy_version
       FROM journal_entries
       WHERE id = ? AND organisation_id = ? AND status = 'POSTED'
         AND reversal_of_id IS NULL`,
    )
    .bind(normalized.journalEntryId, normalized.organisationId)
    .first<Original>();
  if (!original) {
    throw new JournalReversalUnavailableError(
      "The posted journal was not found or is itself a reversal.",
    );
  }
  const lines = await database
    .prepare(
      `SELECT ledger_account_id, direction, asset_code, amount_atomic,
              asset_scale, memo
       FROM journal_lines WHERE journal_entry_id = ? ORDER BY position`,
    )
    .bind(original.id)
    .all<OriginalLine>();
  if (lines.results.length < 2) {
    throw new JournalReversalUnavailableError(
      "The posted journal has no complete line evidence.",
    );
  }
  const reversalLines: JournalLineDraft[] = lines.results.map((line) => ({
    accountId: line.ledger_account_id,
    direction: line.direction === "DEBIT" ? "CREDIT" : "DEBIT",
    amount: {
      assetCode: line.asset_code,
      atomicAmount: line.amount_atomic,
      scale: line.asset_scale,
    },
    memo: `Reversal of ${original.id}${line.memo ? ` · ${line.memo}` : ""}`,
  }));
  const result = await postJournal(database, {
    postingId: normalized.reversalId,
    organisationId: normalized.organisationId,
    sourceType: original.source_type,
    sourceId: original.source_id,
    postingPurpose: `REVERSAL:${original.id}`,
    postingPolicyVersion: `REVERSAL_OF:${original.posting_policy_version}`,
    effectiveAt: normalized.effectiveAt,
    correlationId: normalized.correlationId,
    actorId: normalized.actorId,
    lines: reversalLines,
    reversalOfId: original.id,
    reversalReason: normalized.reason,
    reversalEvidenceReference: normalized.evidenceReference,
  });
  return {
    reversalJournalEntryId: result.journalEntryId,
    originalJournalEntryId: original.id,
    status: result.status,
    replayed: result.replayed,
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
    throw new TypeError("Reversal time must be a UTC timestamp.");
  }
  return value;
}
