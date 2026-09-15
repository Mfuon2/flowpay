import type { JournalLineDraft } from "@flowpay/accounting";

import type { FlowPayQueueMessage } from "../messaging/outbox.ts";
import { postJournal } from "./post-journal.ts";

type Context = Readonly<{
  organisation_id: string;
  settlement_id: string;
  created_at: string;
  correlation_id: string;
  asset_code: string;
  asset_scale: number;
}>;

type Distribution = Readonly<{
  id: string;
  beneficiary_id: string;
  amount_atomic: string;
}>;

type PolicyRow = Readonly<{
  id: string;
  priority: number;
  policy_json: string;
}>;

type AccountMapping = Readonly<{
  beneficiaryId: string;
  debitAccountId: string;
  creditAccountId: string;
}>;

type ObligationPolicy = Readonly<{
  kind: "SETTLEMENT_OBLIGATION_V1";
  assetCode: string;
  scale: number;
  beneficiaryAccounts: readonly AccountMapping[];
}>;

export class SettlementObligationUnavailableError extends Error {
  override readonly name = "SettlementObligationUnavailableError";
}

export async function processSettlementObligation(
  database: D1Database,
  message: FlowPayQueueMessage,
) {
  if (message.messageType !== "FLOWPAY_SETTLEMENT_CREATED") {
    throw new SettlementObligationUnavailableError(
      "Settlement obligation handler received an unsupported message.",
    );
  }
  const settlementId = settlementIdFromPayload(message.payloadJson);
  if (message.aggregateId !== settlementId) {
    throw new SettlementObligationUnavailableError(
      "Settlement obligation message identities differ.",
    );
  }
  const context = await database
    .prepare(
      `SELECT s.organisation_id, s.id AS settlement_id, s.created_at,
              be.correlation_id, s.asset_code, s.asset_scale
       FROM settlements s JOIN business_events be ON be.id = s.source_event_id
       WHERE s.id = ? AND s.organisation_id = ?`,
    )
    .bind(settlementId, message.organisationId)
    .first<Context>();
  if (!context) {
    throw new SettlementObligationUnavailableError(
      "Settlement obligation facts were not found in the organisation.",
    );
  }
  const policyRow = await selectPolicy(database, context);
  const policy = parsePolicy(policyRow.policy_json);
  if (
    policy.assetCode !== context.asset_code ||
    policy.scale !== context.asset_scale
  ) {
    throw new SettlementObligationUnavailableError(
      "Settlement obligation policy precision does not match the settlement.",
    );
  }
  const distributions = await database
    .prepare(
      `SELECT id, beneficiary_id, amount_atomic
       FROM settlement_distributions WHERE settlement_id = ? ORDER BY position`,
    )
    .bind(settlementId)
    .all<Distribution>();
  const accounts = new Map(
    policy.beneficiaryAccounts.map((mapping) => [
      mapping.beneficiaryId,
      mapping,
    ]),
  );
  const lines: JournalLineDraft[] = [];
  for (const distribution of distributions.results) {
    const mapping = accounts.get(distribution.beneficiary_id);
    if (!mapping) continue;
    const amount = {
      assetCode: context.asset_code,
      atomicAmount: distribution.amount_atomic,
      scale: context.asset_scale,
    };
    lines.push(
      {
        accountId: mapping.debitAccountId,
        direction: "DEBIT",
        amount,
        memo: `Entitlement expense for ${distribution.id}`,
      },
      {
        accountId: mapping.creditAccountId,
        direction: "CREDIT",
        amount,
        memo: `Settlement obligation for ${distribution.id}`,
      },
    );
  }
  if (lines.length === 0) {
    return {
      settlementId,
      outcome: "NO_MAPPED_OBLIGATION" as const,
      journalEntryId: null,
      replayed: false,
    };
  }
  const result = await postJournal(database, {
    postingId: `journal:${settlementId}:obligation`,
    organisationId: context.organisation_id,
    sourceType: "SETTLEMENT",
    sourceId: settlementId,
    postingPurpose: "SETTLEMENT_ENTITLEMENT_OBLIGATION",
    postingPolicyVersion: policyRow.id,
    effectiveAt: context.created_at,
    correlationId: context.correlation_id,
    actorId: "settlement-obligation-orchestrator",
    lines,
  });
  return {
    settlementId,
    outcome: "POSTED" as const,
    journalEntryId: result.journalEntryId,
    replayed: result.replayed,
  };
}

async function selectPolicy(database: D1Database, context: Context) {
  const policies = await database
    .prepare(
      `SELECT appv.id, appv.priority, appv.policy_json
       FROM accounting_posting_policy_versions appv
       JOIN accounting_posting_policies app ON app.id = appv.policy_id
       WHERE app.organisation_id = ? AND app.status = 'ACTIVE'
         AND appv.trigger_event_type = 'FLOWPAY_SETTLEMENT_CREATED'
         AND appv.effective_from <= ?
         AND (appv.effective_to IS NULL OR appv.effective_to > ?)
       ORDER BY appv.priority DESC, appv.id`,
    )
    .bind(context.organisation_id, context.created_at, context.created_at)
    .all<PolicyRow>();
  const selected = policies.results[0];
  if (!selected) {
    throw new SettlementObligationUnavailableError(
      "No effective settlement obligation policy was found.",
    );
  }
  if (policies.results[1]?.priority === selected.priority) {
    throw new SettlementObligationUnavailableError(
      "Multiple settlement obligation policies share highest priority.",
    );
  }
  return selected;
}

function parsePolicy(value: string): ObligationPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw invalidPolicy();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("kind" in parsed) ||
    parsed.kind !== "SETTLEMENT_OBLIGATION_V1" ||
    !("assetCode" in parsed) ||
    typeof parsed.assetCode !== "string" ||
    !("scale" in parsed) ||
    typeof parsed.scale !== "number" ||
    !Number.isSafeInteger(parsed.scale) ||
    !("beneficiaryAccounts" in parsed)
  ) {
    throw invalidPolicy();
  }
  const values = unknownArray(parsed.beneficiaryAccounts);
  if (!values) throw invalidPolicy();
  const mappings: AccountMapping[] = [];
  const beneficiaries = new Set<string>();
  for (const item of values) {
    if (
      typeof item !== "object" ||
      item === null ||
      !("beneficiaryId" in item) ||
      typeof item.beneficiaryId !== "string" ||
      !("debitAccountId" in item) ||
      typeof item.debitAccountId !== "string" ||
      !("creditAccountId" in item) ||
      typeof item.creditAccountId !== "string" ||
      beneficiaries.has(item.beneficiaryId)
    ) {
      throw invalidPolicy();
    }
    beneficiaries.add(item.beneficiaryId);
    mappings.push({
      beneficiaryId: item.beneficiaryId,
      debitAccountId: item.debitAccountId,
      creditAccountId: item.creditAccountId,
    });
  }
  return {
    kind: parsed.kind,
    assetCode: parsed.assetCode,
    scale: parsed.scale,
    beneficiaryAccounts: mappings,
  };
}

function unknownArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item: unknown) => item);
}

function settlementIdFromPayload(payloadJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson) as unknown;
  } catch {
    throw new SettlementObligationUnavailableError(
      "Settlement obligation payload is invalid JSON.",
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("settlementId" in parsed) ||
    typeof parsed.settlementId !== "string" ||
    !parsed.settlementId
  ) {
    throw new SettlementObligationUnavailableError(
      "Settlement obligation payload has no settlement ID.",
    );
  }
  return parsed.settlementId;
}

function invalidPolicy() {
  return new SettlementObligationUnavailableError(
    "Settlement obligation policy has an invalid shape.",
  );
}
