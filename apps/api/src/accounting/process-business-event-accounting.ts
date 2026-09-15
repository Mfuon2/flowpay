import type { JournalLineDraft } from "@flowpay/accounting";

import { postJournal } from "./post-journal.ts";

type Context = Readonly<{
  event_id: string;
  organisation_id: string;
  event_type: "INVOICE_ISSUED" | "PAYMENT_CONFIRMED";
  occurred_at: string;
  correlation_id: string;
  asset_code: string;
  amount_atomic: string;
  asset_scale: number;
}>;

type PolicyRow = Readonly<{
  id: string;
  priority: number;
  policy_json: string;
}>;

type BusinessPolicy =
  | Readonly<{
      kind: "INVOICE_ISSUED_V1";
      assetCode: string;
      scale: number;
      receivableDebitAccountId: string;
      revenueCreditAccountId: string;
    }>
  | Readonly<{
      kind: "PAYMENT_RECEIPT_V1";
      assetCode: string;
      scale: number;
      cashDebitAccountId: string;
      receivableCreditAccountId: string;
    }>;

export class BusinessAccountingUnavailableError extends Error {
  override readonly name = "BusinessAccountingUnavailableError";
}

export async function processBusinessEventAccounting(
  database: D1Database,
  eventId: string,
) {
  const context = await loadContext(database, eventId);
  const policyRow = await selectPolicy(database, context);
  const policy = parsePolicy(policyRow.policy_json, context.event_type);
  if (
    policy.assetCode !== context.asset_code ||
    policy.scale !== context.asset_scale
  ) {
    throw new BusinessAccountingUnavailableError(
      "Business accounting policy precision does not match the event.",
    );
  }
  const amount = {
    assetCode: context.asset_code,
    atomicAmount: context.amount_atomic,
    scale: context.asset_scale,
  };
  const lines: readonly JournalLineDraft[] =
    policy.kind === "INVOICE_ISSUED_V1"
      ? [
          {
            accountId: policy.receivableDebitAccountId,
            direction: "DEBIT",
            amount,
            memo: `Receivable recognized by ${context.event_id}`,
          },
          {
            accountId: policy.revenueCreditAccountId,
            direction: "CREDIT",
            amount,
            memo: `Revenue recognized by ${context.event_id}`,
          },
        ]
      : [
          {
            accountId: policy.cashDebitAccountId,
            direction: "DEBIT",
            amount,
            memo: `Receipt recognized by ${context.event_id}`,
          },
          {
            accountId: policy.receivableCreditAccountId,
            direction: "CREDIT",
            amount,
            memo: `Receivable cleared by ${context.event_id}`,
          },
        ];
  const result = await postJournal(database, {
    postingId: `journal:${context.event_id}:${policy.kind}`,
    organisationId: context.organisation_id,
    sourceType: "BUSINESS_EVENT",
    sourceId: context.event_id,
    postingPurpose: policy.kind,
    postingPolicyVersion: policyRow.id,
    effectiveAt: context.occurred_at,
    correlationId: context.correlation_id,
    actorId: "business-accounting-orchestrator",
    lines,
  });
  return { ...result, eventId: context.event_id, policyKind: policy.kind };
}

async function loadContext(database: D1Database, eventId: string) {
  const context = await database
    .prepare(
      `SELECT be.id AS event_id, be.organisation_id, be.event_type,
              be.occurred_at, be.correlation_id,
              COALESCE(i.asset_code, p.asset_code) AS asset_code,
              COALESCE(i.total_atomic, p.amount_atomic) AS amount_atomic,
              COALESCE(i.asset_scale, p.asset_scale) AS asset_scale
       FROM business_events be
       LEFT JOIN invoices i
         ON be.aggregate_type = 'INVOICE' AND i.id = be.aggregate_id
         AND i.organisation_id = be.organisation_id
       LEFT JOIN payments p
         ON be.aggregate_type = 'PAYMENT' AND p.id = be.aggregate_id
         AND p.organisation_id = be.organisation_id
       WHERE be.id = ? AND be.event_type IN ('INVOICE_ISSUED', 'PAYMENT_CONFIRMED')`,
    )
    .bind(eventId)
    .first<Context>();
  if (!context || !context.asset_code || !context.amount_atomic) {
    throw new BusinessAccountingUnavailableError(
      "Business event accounting facts are unavailable.",
    );
  }
  return context;
}

async function selectPolicy(database: D1Database, context: Context) {
  const policies = await database
    .prepare(
      `SELECT appv.id, appv.priority, appv.policy_json
       FROM accounting_posting_policy_versions appv
       JOIN accounting_posting_policies app ON app.id = appv.policy_id
       WHERE app.organisation_id = ? AND app.status = 'ACTIVE'
         AND appv.trigger_event_type = ? AND appv.effective_from <= ?
         AND (appv.effective_to IS NULL OR appv.effective_to > ?)
       ORDER BY appv.priority DESC, appv.id`,
    )
    .bind(
      context.organisation_id,
      context.event_type,
      context.occurred_at,
      context.occurred_at,
    )
    .all<PolicyRow>();
  const selected = policies.results[0];
  if (!selected) {
    throw new BusinessAccountingUnavailableError(
      `No effective ${context.event_type} accounting policy was found.`,
    );
  }
  if (policies.results[1]?.priority === selected.priority) {
    throw new BusinessAccountingUnavailableError(
      `Multiple ${context.event_type} accounting policies share highest priority.`,
    );
  }
  return selected;
}

function parsePolicy(
  value: string,
  eventType: Context["event_type"],
): BusinessPolicy {
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
    !("assetCode" in parsed) ||
    typeof parsed.assetCode !== "string" ||
    !("scale" in parsed) ||
    typeof parsed.scale !== "number" ||
    !Number.isSafeInteger(parsed.scale)
  ) {
    throw invalidPolicy();
  }
  if (
    eventType === "INVOICE_ISSUED" &&
    parsed.kind === "INVOICE_ISSUED_V1" &&
    "receivableDebitAccountId" in parsed &&
    typeof parsed.receivableDebitAccountId === "string" &&
    "revenueCreditAccountId" in parsed &&
    typeof parsed.revenueCreditAccountId === "string"
  ) {
    return {
      kind: parsed.kind,
      assetCode: parsed.assetCode,
      scale: parsed.scale,
      receivableDebitAccountId: parsed.receivableDebitAccountId,
      revenueCreditAccountId: parsed.revenueCreditAccountId,
    };
  }
  if (
    eventType === "PAYMENT_CONFIRMED" &&
    parsed.kind === "PAYMENT_RECEIPT_V1" &&
    "cashDebitAccountId" in parsed &&
    typeof parsed.cashDebitAccountId === "string" &&
    "receivableCreditAccountId" in parsed &&
    typeof parsed.receivableCreditAccountId === "string"
  ) {
    return {
      kind: parsed.kind,
      assetCode: parsed.assetCode,
      scale: parsed.scale,
      cashDebitAccountId: parsed.cashDebitAccountId,
      receivableCreditAccountId: parsed.receivableCreditAccountId,
    };
  }
  throw invalidPolicy();
}

function invalidPolicy() {
  return new BusinessAccountingUnavailableError(
    "Business accounting policy has an invalid or mismatched shape.",
  );
}
