import { createMoney, type SerializedMoney } from "@flowpay/domain";

export type JournalLineDraft = Readonly<{
  accountId: string;
  direction: "DEBIT" | "CREDIT";
  amount: SerializedMoney;
  memo?: string;
}>;

export type JournalDraft = Readonly<{
  lines: readonly JournalLineDraft[];
}>;

export class InvalidJournalDraftError extends Error {
  override readonly name = "InvalidJournalDraftError";
}

export function validateJournalDraft(draft: JournalDraft): JournalDraft {
  if (draft.lines.length < 2) {
    throw new InvalidJournalDraftError(
      "A journal requires at least two lines.",
    );
  }
  const totals = new Map<string, { debit: bigint; credit: bigint }>();
  for (const line of draft.lines) {
    requireIdentifier("Ledger account ID", line.accountId);
    const money = createMoney(
      line.amount.assetCode,
      line.amount.atomicAmount,
      line.amount.scale,
    );
    if (money.atomicAmount === 0n) {
      throw new InvalidJournalDraftError(
        "Journal line amounts must be greater than zero.",
      );
    }
    const key = `${money.assetCode}:${money.scale}`;
    const total = totals.get(key) ?? { debit: 0n, credit: 0n };
    total[line.direction === "DEBIT" ? "debit" : "credit"] +=
      money.atomicAmount;
    totals.set(key, total);
  }
  for (const [asset, total] of totals) {
    if (total.debit !== total.credit) {
      throw new InvalidJournalDraftError(
        `Journal is not balanced for ${asset}: debits ${total.debit} do not equal credits ${total.credit}.`,
      );
    }
  }
  return draft;
}

function requireIdentifier(label: string, value: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new InvalidJournalDraftError(`${label} must be a trimmed value.`);
  }
}
