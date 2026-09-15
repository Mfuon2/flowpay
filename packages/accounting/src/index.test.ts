import { describe, expect, it } from "vitest";

import { InvalidJournalDraftError, validateJournalDraft } from "./index.ts";

describe("validateJournalDraft", () => {
  it("balances exact values beyond JavaScript's safe integer range", () => {
    const amount = "900719925474099312345678";
    expect(
      validateJournalDraft({
        lines: [
          {
            accountId: "digital-cash",
            direction: "DEBIT",
            amount: { assetCode: "USD", atomicAmount: amount, scale: 2 },
          },
          {
            accountId: "receivable",
            direction: "CREDIT",
            amount: { assetCode: "USD", atomicAmount: amount, scale: 2 },
          },
        ],
      }).lines,
    ).toHaveLength(2);
  });

  it("rejects unbalanced and zero-value journals", () => {
    expect(() =>
      validateJournalDraft({
        lines: [
          {
            accountId: "cash",
            direction: "DEBIT",
            amount: { assetCode: "USD", atomicAmount: "100", scale: 2 },
          },
          {
            accountId: "payable",
            direction: "CREDIT",
            amount: { assetCode: "USD", atomicAmount: "99", scale: 2 },
          },
        ],
      }),
    ).toThrow(InvalidJournalDraftError);
    expect(() =>
      validateJournalDraft({
        lines: [
          {
            accountId: "cash",
            direction: "DEBIT",
            amount: { assetCode: "USD", atomicAmount: "0", scale: 2 },
          },
          {
            accountId: "payable",
            direction: "CREDIT",
            amount: { assetCode: "USD", atomicAmount: "0", scale: 2 },
          },
        ],
      }),
    ).toThrow(/greater than zero/);
  });

  it("requires every asset and scale bucket to balance independently", () => {
    expect(() =>
      validateJournalDraft({
        lines: [
          {
            accountId: "usd-cash",
            direction: "DEBIT",
            amount: { assetCode: "USD", atomicAmount: "100", scale: 2 },
          },
          {
            accountId: "usdc-payable",
            direction: "CREDIT",
            amount: { assetCode: "USDC", atomicAmount: "1000000", scale: 6 },
          },
        ],
      }),
    ).toThrow(/not balanced/);
  });
});
