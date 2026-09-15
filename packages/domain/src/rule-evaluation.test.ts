import { describe, expect, it } from "vitest";

import { selectSettlementRule, type SettlementRuleVersion } from "./index.ts";

function rule(
  overrides: Partial<SettlementRuleVersion> = {},
): SettlementRuleVersion {
  return {
    id: "rule-version-1",
    ruleId: "rule-1",
    version: 1,
    triggerEventType: "PAYMENT_CONFIRMED",
    triggerSchemaVersion: 1,
    conditions: [
      { fact: "job.status", operator: "EQUALS", value: "COMPLETED" },
      {
        fact: "payment.amount",
        operator: "MONEY_AT_LEAST",
        value: { assetCode: "USD", atomicAmount: "10000", scale: 2 },
      },
    ],
    beneficiaries: [
      { kind: "PERCENTAGE", beneficiaryId: "workshop", basisPoints: 2500 },
      { kind: "REMAINDER", beneficiaryId: "contractor" },
    ],
    providerPolicy: {
      providerKey: "simulation",
      network: "simnet",
      method: "INDIVIDUAL_TRANSFERS",
    },
    effectiveFrom: "2026-09-01T00:00:00Z",
    priority: 10,
    ...overrides,
  };
}

const input = {
  eventType: "PAYMENT_CONFIRMED",
  eventSchemaVersion: 1,
  occurredAt: "2026-09-14T08:00:00Z",
  facts: {
    "job.status": "COMPLETED",
    "payment.amount": {
      assetCode: "USD",
      atomicAmount: "100000",
      scale: 2,
    },
  },
} as const;

describe("settlement rule selection", () => {
  it("selects the highest-priority matching rule and preserves evidence", () => {
    const lower = rule({ id: "lower", ruleId: "lower", priority: 5 });
    const higher = rule({ id: "higher", ruleId: "higher", priority: 20 });
    const result = selectSettlementRule({ ...input, rules: [lower, higher] });

    expect(result.outcome).toBe("MATCHED");
    if (result.outcome !== "MATCHED") throw new Error("Expected match");
    expect(result.rule.id).toBe("higher");
    expect(result.evaluations).toHaveLength(2);
    expect(result.evaluations[0]?.conditions).toMatchObject([
      { passed: true },
      { passed: true },
    ]);
  });

  it("reports an equal-priority conflict instead of choosing silently", () => {
    const result = selectSettlementRule({
      ...input,
      rules: [
        rule({ id: "rule-b", ruleId: "rule-b" }),
        rule({ id: "rule-a", ruleId: "rule-a" }),
      ],
    });

    expect(result).toMatchObject({
      outcome: "CONFLICT",
      conflictingRuleVersionIds: ["rule-a", "rule-b"],
      priority: 10,
    });
  });

  it("uses an inclusive start and exclusive end at event time", () => {
    const active = rule({
      effectiveFrom: input.occurredAt,
      effectiveTo: "2026-09-15T00:00:00Z",
    });
    expect(selectSettlementRule({ ...input, rules: [active] }).outcome).toBe(
      "MATCHED",
    );

    const expired = rule({ effectiveTo: input.occurredAt });
    const result = selectSettlementRule({ ...input, rules: [expired] });
    expect(result.outcome).toBe("NO_MATCH");
    expect(result.evaluations[0]?.eligible).toBe(false);
    expect(result.evaluations[0]?.reason).toMatch(/effective window/);
  });

  it("does not match wrong triggers, failed conditions, or money precision", () => {
    const wrongTrigger = rule({ triggerEventType: "JOB_COMPLETED" });
    const result = selectSettlementRule({
      ...input,
      facts: {
        ...input.facts,
        "job.status": "STARTED",
        "payment.amount": {
          assetCode: "USDC",
          atomicAmount: "1000000000",
          scale: 6,
        },
      },
      rules: [wrongTrigger, rule()],
    });

    expect(result.outcome).toBe("NO_MATCH");
    expect(result.evaluations).toMatchObject([
      { eligible: false, matched: false },
      {
        eligible: true,
        matched: false,
        conditions: [
          { passed: false },
          { passed: false, reason: "Money asset or scale does not match." },
        ],
      },
    ]);
  });

  it("supports EXISTS and IN without treating absent facts as values", () => {
    const conditions: SettlementRuleVersion["conditions"] = [
      { fact: "invoice.id", operator: "EXISTS" },
      {
        fact: "payment.method",
        operator: "IN",
        values: ["CARD", "BANK"],
      },
    ];
    const matched = selectSettlementRule({
      ...input,
      facts: { "invoice.id": "invoice-1", "payment.method": "BANK" },
      rules: [rule({ conditions })],
    });
    expect(matched.outcome).toBe("MATCHED");

    const absent = selectSettlementRule({
      ...input,
      facts: { "payment.method": "BANK" },
      rules: [rule({ conditions })],
    });
    expect(absent.outcome).toBe("NO_MATCH");
  });

  it("rejects malformed rule versions instead of silently skipping them", () => {
    expect(() =>
      selectSettlementRule({
        ...input,
        rules: [rule({ effectiveTo: "2026-08-01T00:00:00Z" })],
      }),
    ).toThrow(/later than/);
    expect(() =>
      selectSettlementRule({
        ...input,
        rules: [
          rule({ conditions: [{ fact: "x", operator: "IN", values: [] }] }),
        ],
      }),
    ).toThrow(/at least one value/);
  });
});
