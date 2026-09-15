import {
  validateJournalDraft,
  type JournalLineDraft,
} from "@flowpay/accounting";

import { hashCanonicalJson } from "../flowpay/canonical-json.ts";
import {
  auditStatement,
  outboxStatement,
} from "../flowpay/evidence-statements.ts";

export type PostJournalCommand = Readonly<{
  postingId: string;
  organisationId: string;
  sourceType: "BUSINESS_EVENT" | "SETTLEMENT" | "SETTLEMENT_DISTRIBUTION";
  sourceId: string;
  postingPurpose: string;
  postingPolicyVersion: string;
  effectiveAt: string;
  correlationId: string;
  actorId: string;
  lines: readonly JournalLineDraft[];
  reversalOfId?: string;
  reversalReason?: string;
  reversalEvidenceReference?: string;
}>;

export type PostJournalResult = Readonly<{
  journalEntryId: string;
  status: "POSTED";
  replayed: boolean;
}>;

export class JournalPostingConflictError extends Error {
  override readonly name = "JournalPostingConflictError";
}

export class JournalPostingUnavailableError extends Error {
  override readonly name = "JournalPostingUnavailableError";
}

type ExistingJournal = Readonly<{
  id: string;
  posting_fingerprint: string;
  status: "POSTED";
}>;

type AccountRow = Readonly<{
  id: string;
  asset_code: string;
  asset_scale: number;
}>;

export async function postJournal(
  database: D1Database,
  command: PostJournalCommand,
): Promise<PostJournalResult> {
  validateCommand(command);
  validateJournalDraft({ lines: command.lines });
  const fingerprint = await hashCanonicalJson({
    organisationId: command.organisationId,
    sourceType: command.sourceType,
    sourceId: command.sourceId,
    postingPurpose: command.postingPurpose,
    postingPolicyVersion: command.postingPolicyVersion,
    effectiveAt: command.effectiveAt,
    correlationId: command.correlationId,
    reversalOfId: command.reversalOfId ?? null,
    reversalReason: command.reversalReason ?? null,
    reversalEvidenceReference: command.reversalEvidenceReference ?? null,
    lines: command.lines.map((line) => ({
      accountId: line.accountId,
      direction: line.direction,
      amount: line.amount,
      memo: line.memo ?? null,
    })),
  });
  const existing = await findExisting(database, command);
  if (existing) return replayResult(existing, fingerprint);

  await verifySource(database, command);
  await verifyReversal(database, command);
  await verifyAccounts(database, command);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `INSERT INTO journal_entries (
          id, organisation_id, source_type, source_id, posting_purpose,
          posting_policy_version, status, effective_at, created_at,
          posting_fingerprint, correlation_id, reversal_of_id
        ) VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`,
      )
      .bind(
        command.postingId,
        command.organisationId,
        command.sourceType,
        command.sourceId,
        command.postingPurpose,
        command.postingPolicyVersion,
        command.effectiveAt,
        now,
        fingerprint,
        command.correlationId,
        command.reversalOfId ?? null,
      ),
    ...command.lines.map((line, position) =>
      database
        .prepare(
          `INSERT INTO journal_lines (
            id, journal_entry_id, ledger_account_id, position, direction,
            asset_code, amount_atomic, asset_scale, memo
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `${command.postingId}:${position}`,
          command.postingId,
          line.accountId,
          position,
          line.direction,
          line.amount.assetCode,
          line.amount.atomicAmount,
          line.amount.scale,
          line.memo ?? null,
        ),
    ),
    database
      .prepare(
        `UPDATE journal_entries SET status = 'POSTED', posted_at = ?
         WHERE id = ? AND status = 'DRAFT'`,
      )
      .bind(now, command.postingId),
    auditStatement(database, {
      id: crypto.randomUUID(),
      organisationId: command.organisationId,
      actorType: "SERVICE",
      actorId: command.actorId,
      action: "JOURNAL_POSTED",
      aggregateType: "JOURNAL_ENTRY",
      aggregateId: command.postingId,
      correlationId: command.correlationId,
      causationId: command.sourceId,
      evidence: {
        sourceType: command.sourceType,
        sourceId: command.sourceId,
        postingPurpose: command.postingPurpose,
        postingPolicyVersion: command.postingPolicyVersion,
        lineCount: command.lines.length,
        reversalOfId: command.reversalOfId ?? null,
        reversalReason: command.reversalReason ?? null,
        reversalEvidenceReference: command.reversalEvidenceReference ?? null,
      },
      occurredAt: now,
    }),
    outboxStatement(database, {
      id: crypto.randomUUID(),
      organisationId: command.organisationId,
      messageType: "ACCOUNTING_JOURNAL_POSTED",
      aggregateType: "JOURNAL_ENTRY",
      aggregateId: command.postingId,
      correlationId: command.correlationId,
      causationId: command.sourceId,
      payload: {
        journalEntryId: command.postingId,
        sourceType: command.sourceType,
        sourceId: command.sourceId,
        postingPurpose: command.postingPurpose,
      },
      createdAt: now,
    }),
  ];
  try {
    await database.batch(statements);
  } catch (error) {
    const concurrent = await findExisting(database, command);
    if (concurrent) return replayResult(concurrent, fingerprint);
    throw error;
  }
  return {
    journalEntryId: command.postingId,
    status: "POSTED",
    replayed: false,
  };
}

async function verifyReversal(
  database: D1Database,
  command: PostJournalCommand,
): Promise<void> {
  if (!command.reversalOfId) return;
  if (!command.reversalReason || !command.reversalEvidenceReference) {
    throw new TypeError(
      "A journal reversal requires a reason and evidence reference.",
    );
  }
  const original = await database
    .prepare(
      `SELECT id FROM journal_entries
       WHERE id = ? AND organisation_id = ? AND status = 'POSTED'
         AND reversal_of_id IS NULL`,
    )
    .bind(command.reversalOfId, command.organisationId)
    .first<string>("id");
  if (!original) {
    throw new JournalPostingUnavailableError(
      "The original posted journal is unavailable for reversal.",
    );
  }
}

async function verifySource(
  database: D1Database,
  command: PostJournalCommand,
): Promise<void> {
  const table = {
    BUSINESS_EVENT: "business_events",
    SETTLEMENT: "settlements",
    SETTLEMENT_DISTRIBUTION: "settlement_distributions",
  }[command.sourceType];
  const query =
    command.sourceType === "SETTLEMENT_DISTRIBUTION"
      ? `SELECT sd.id FROM settlement_distributions sd
         JOIN settlements s ON s.id = sd.settlement_id
         WHERE sd.id = ? AND s.organisation_id = ?`
      : `SELECT id FROM ${table} WHERE id = ? AND organisation_id = ?`;
  const sourceId = await database
    .prepare(query)
    .bind(command.sourceId, command.organisationId)
    .first<string>("id");
  if (!sourceId) {
    throw new JournalPostingUnavailableError(
      "The journal source was not found in the organisation.",
    );
  }
}

async function verifyAccounts(
  database: D1Database,
  command: PostJournalCommand,
): Promise<void> {
  const accountIds = [
    ...new Set(command.lines.map(({ accountId }) => accountId)),
  ];
  const placeholders = accountIds.map(() => "?").join(", ");
  const rows = await database
    .prepare(
      `SELECT id, asset_code, asset_scale FROM ledger_accounts
       WHERE organisation_id = ? AND status = 'ACTIVE'
         AND id IN (${placeholders})`,
    )
    .bind(command.organisationId, ...accountIds)
    .all<AccountRow>();
  const accounts = new Map(
    rows.results.map((account) => [account.id, account]),
  );
  for (const line of command.lines) {
    const account = accounts.get(line.accountId);
    if (
      !account ||
      account.asset_code !== line.amount.assetCode ||
      account.asset_scale !== line.amount.scale
    ) {
      throw new JournalPostingUnavailableError(
        `Ledger account ${line.accountId} is unavailable or has a different asset precision.`,
      );
    }
  }
}

async function findExisting(
  database: D1Database,
  command: Pick<
    PostJournalCommand,
    "organisationId" | "sourceType" | "sourceId" | "postingPurpose"
  >,
): Promise<ExistingJournal | null> {
  return database
    .prepare(
      `SELECT id, posting_fingerprint, status FROM journal_entries
       WHERE organisation_id = ? AND source_type = ? AND source_id = ?
         AND posting_purpose = ?`,
    )
    .bind(
      command.organisationId,
      command.sourceType,
      command.sourceId,
      command.postingPurpose,
    )
    .first<ExistingJournal>();
}

function replayResult(
  existing: ExistingJournal,
  fingerprint: string,
): PostJournalResult {
  if (existing.posting_fingerprint !== fingerprint) {
    throw new JournalPostingConflictError(
      "The posting identity already exists with different financial data.",
    );
  }
  if (existing.status !== "POSTED") {
    throw new JournalPostingUnavailableError(
      "The existing journal posting is not complete.",
    );
  }
  return { journalEntryId: existing.id, status: "POSTED", replayed: true };
}

function validateCommand(command: PostJournalCommand): void {
  for (const [label, value] of [
    ["Posting ID", command.postingId],
    ["Organisation ID", command.organisationId],
    ["Source ID", command.sourceId],
    ["Posting purpose", command.postingPurpose],
    ["Posting policy version", command.postingPolicyVersion],
    ["Correlation ID", command.correlationId],
    ["Actor ID", command.actorId],
  ] as const) {
    if (value.length === 0 || value !== value.trim()) {
      throw new TypeError(`${label} must be a trimmed value.`);
    }
  }
  const effectiveAt = Date.parse(command.effectiveAt);
  if (!Number.isFinite(effectiveAt) || !command.effectiveAt.endsWith("Z")) {
    throw new TypeError("Effective time must be a UTC timestamp.");
  }
}
