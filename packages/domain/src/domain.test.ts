import { describe, expect, it } from "vitest";

import {
  SETTLEMENT_ACTIONS,
  SETTLEMENT_STATES,
  calculateDistributions,
  createBusinessEvent,
  createMoney,
  deserializeMoney,
  resolveApprovalBand,
  serializeMoney,
  transitionSettlement,
  validateApprovalPolicy,
  type ApprovalPolicyVersion,
  type SettlementAction,
  type SettlementState,
} from "./index.ts";

describe("business event envelope", () => {
  it("accepts a versioned, correlated business fact", () => {
    const event = createBusinessEvent({
      id: "event-1",
      organisationId: "org-1",
      source: "workshop-demo",
      externalEventId: "payment-1-confirmed",
      eventType: "PAYMENT_CONFIRMED",
      schemaVersion: 1,
      aggregateType: "PAYMENT",
      aggregateId: "payment-1",
      occurredAt: "2026-09-14T08:00:00Z",
      recordedAt: "2026-09-14T08:00:01.123Z",
      correlationId: "correlation-1",
      payload: { paymentId: "payment-1", amountAtomic: "100000" },
    });

    expect(event.eventType).toBe("PAYMENT_CONFIRMED");
    expect(Object.isFrozen(event)).toBe(true);
  });

  it("rejects invalid versions, identifiers, and non-UTC timestamps", () => {
    const valid = {
      id: "event-1",
      organisationId: "org-1",
      source: "test",
      externalEventId: "external-1",
      eventType: "PAYMENT_CONFIRMED",
      schemaVersion: 1,
      aggregateType: "PAYMENT",
      aggregateId: "payment-1",
      occurredAt: "2026-09-14T08:00:00Z",
      recordedAt: "2026-09-14T08:00:01Z",
      correlationId: "correlation-1",
      payload: {},
    } as const;

    expect(() => createBusinessEvent({ ...valid, schemaVersion: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => createBusinessEvent({ ...valid, source: " test" })).toThrow(
      /trimmed/,
    );
    expect(() =>
      createBusinessEvent({
        ...valid,
        occurredAt: "2026-09-14T11:00:00+03:00",
      }),
    ).toThrow(/UTC timestamp/);
  });
});

describe("exact money", () => {
  it("round-trips atomic amounts larger than Number.MAX_SAFE_INTEGER", () => {
    const money = createMoney("USDC", "9007199254740993123456", 6);

    expect(serializeMoney(money)).toEqual({
      assetCode: "USDC",
      atomicAmount: "9007199254740993123456",
      scale: 6,
    });
    expect(deserializeMoney(serializeMoney(money))).toEqual(money);
  });

  it.each(["12.5", "1e6", "01", "-1", "", " 1"])(
    "rejects non-canonical atomic amount %s",
    (atomicAmount) => {
      expect(() => createMoney("USDC", atomicAmount, 6)).toThrow();
    },
  );

  it("rejects invalid asset codes, scales, and negative bigint values", () => {
    expect(() => createMoney("usdc", "1", 6)).toThrow();
    expect(() => createMoney("USDC", "1", 1.5)).toThrow();
    expect(() => createMoney("USDC", -1n, 6)).toThrow();
  });
});

describe("settlement distribution calculation", () => {
  it("calculates the flagship workshop split exactly", () => {
    const result = calculateDistributions(createMoney("USD", "100000", 2), [
      { kind: "PERCENTAGE", beneficiaryId: "workshop", basisPoints: 2500 },
      { kind: "PERCENTAGE", beneficiaryId: "mechanic", basisPoints: 7000 },
      { kind: "PERCENTAGE", beneficiaryId: "referrer", basisPoints: 500 },
    ]);

    expect(
      result.distributions.map(({ beneficiaryId, amount }) => [
        beneficiaryId,
        amount.atomicAmount,
      ]),
    ).toEqual([
      ["workshop", 25_000n],
      ["mechanic", 70_000n],
      ["referrer", 5_000n],
    ]);
  });

  it("uses largest remainders and instruction order for deterministic rounding", () => {
    const result = calculateDistributions(createMoney("USD", "100", 2), [
      { kind: "PERCENTAGE", beneficiaryId: "first", basisPoints: 3333 },
      { kind: "PERCENTAGE", beneficiaryId: "second", basisPoints: 3333 },
      { kind: "PERCENTAGE", beneficiaryId: "third", basisPoints: 3334 },
    ]);

    expect(
      result.distributions.map(({ amount }) => amount.atomicAmount),
    ).toEqual([33n, 33n, 34n]);
    expect(
      result.distributions.map(
        ({ roundingAdjustmentAtomic }) => roundingAdjustmentAtomic,
      ),
    ).toEqual(["0", "0", "1"]);
  });

  it("assigns every residual unit to an explicit remainder beneficiary", () => {
    const result = calculateDistributions(createMoney("USD", "1001", 2), [
      { kind: "PERCENTAGE", beneficiaryId: "workshop", basisPoints: 2500 },
      { kind: "PERCENTAGE", beneficiaryId: "mechanic", basisPoints: 7000 },
      { kind: "REMAINDER", beneficiaryId: "referrer" },
    ]);

    expect(
      result.distributions.map(({ amount }) => amount.atomicAmount),
    ).toEqual([250n, 700n, 51n]);
  });

  it("supports fixed amounts only when the complete allocation is exact", () => {
    const result = calculateDistributions(createMoney("USD", "1000", 2), [
      { kind: "FIXED", beneficiaryId: "fixed", atomicAmount: "100" },
      { kind: "PERCENTAGE", beneficiaryId: "share", basisPoints: 9000 },
    ]);

    expect(
      result.distributions.map(({ amount }) => amount.atomicAmount),
    ).toEqual([100n, 900n]);
  });

  it("rejects incomplete, excessive, duplicate, and ambiguous allocations", () => {
    const total = createMoney("USD", "1000", 2);
    expect(() =>
      calculateDistributions(total, [
        { kind: "PERCENTAGE", beneficiaryId: "one", basisPoints: 5000 },
      ]),
    ).toThrow(/full amount/);
    expect(() =>
      calculateDistributions(total, [
        { kind: "FIXED", beneficiaryId: "one", atomicAmount: "1001" },
        { kind: "REMAINDER", beneficiaryId: "two" },
      ]),
    ).toThrow(/exceed/);
    expect(() =>
      calculateDistributions(total, [
        { kind: "PERCENTAGE", beneficiaryId: "same", basisPoints: 5000 },
        { kind: "REMAINDER", beneficiaryId: "same" },
      ]),
    ).toThrow(/only once/);
    expect(() =>
      calculateDistributions(total, [
        { kind: "REMAINDER", beneficiaryId: "one" },
        { kind: "REMAINDER", beneficiaryId: "two" },
      ]),
    ).toThrow(/Only one remainder/);
  });
});

describe("settlement state transitions", () => {
  const allowed: ReadonlyArray<
    readonly [SettlementState, SettlementAction, SettlementState]
  > = [
    ["DRAFT", "BEGIN_RULE_EVALUATION", "PENDING_RULE_EVALUATION"],
    ["PENDING_RULE_EVALUATION", "REQUIRE_APPROVAL", "PENDING_APPROVAL"],
    ["PENDING_RULE_EVALUATION", "MARK_READY", "READY"],
    ["PENDING_APPROVAL", "MARK_READY", "READY"],
    ["READY", "BEGIN_SUBMISSION", "SUBMITTING"],
    ["SUBMITTING", "ACCEPT_SUBMISSION", "SUBMITTED"],
    ["SUBMITTING", "CONFIRM", "CONFIRMED"],
    ["SUBMITTING", "FAIL", "FAILED"],
    ["SUBMITTED", "CONFIRM", "CONFIRMED"],
    ["SUBMITTED", "FAIL", "FAILED"],
    ["CONFIRMED", "REVERSE", "REVERSED"],
    ["FAILED", "RETRY", "READY"],
    ["DRAFT", "CANCEL", "CANCELLED"],
    ["PENDING_RULE_EVALUATION", "FAIL", "FAILED"],
    ["PENDING_RULE_EVALUATION", "CANCEL", "CANCELLED"],
    ["PENDING_APPROVAL", "FAIL", "FAILED"],
    ["PENDING_APPROVAL", "CANCEL", "CANCELLED"],
    ["READY", "CANCEL", "CANCELLED"],
  ];

  it.each(allowed)("allows %s + %s → %s", (current, action, expected) => {
    expect(transitionSettlement(current, action)).toBe(expected);
  });

  it("rejects every transition not present in the explicit state map", () => {
    const allowedKeys = new Set(
      allowed.map(([state, action]) => `${state}:${action}`),
    );
    for (const state of SETTLEMENT_STATES) {
      for (const action of SETTLEMENT_ACTIONS) {
        if (allowedKeys.has(`${state}:${action}`)) continue;
        expect(() => transitionSettlement(state, action)).toThrow(
          /not allowed/,
        );
      }
    }
  });
});

describe("approval policy thresholds", () => {
  const policy: ApprovalPolicyVersion = {
    id: "policy-version-1",
    policyId: "policy-1",
    version: 1,
    assetCode: "USD",
    assetScale: 2,
    bands: [
      {
        minAtomicAmount: "0",
        maxAtomicAmount: "50000",
        mode: "AUTOMATIC",
        requirements: [],
      },
      {
        minAtomicAmount: "50001",
        maxAtomicAmount: "500000",
        mode: "APPROVAL_REQUIRED",
        requirements: [{ role: "MANAGER", count: 1, allowSelfApproval: false }],
      },
      {
        minAtomicAmount: "500001",
        maxAtomicAmount: null,
        mode: "APPROVAL_REQUIRED",
        requirements: [{ role: "FINANCE", count: 2, allowSelfApproval: false }],
      },
    ],
  };

  it.each([
    ["50000", "AUTOMATIC", 0],
    ["50001", "APPROVAL_REQUIRED", 1],
    ["500000", "APPROVAL_REQUIRED", 1],
    ["500001", "APPROVAL_REQUIRED", 2],
  ] as const)(
    "resolves exact boundary %s to %s",
    (atomicAmount, mode, count) => {
      const band = resolveApprovalBand(
        policy,
        createMoney("USD", atomicAmount, 2),
      );
      expect(band.mode).toBe(mode);
      expect(band.requirements[0]?.count ?? 0).toBe(count);
    },
  );

  it("rejects gaps, invalid automatic requirements, and wrong assets", () => {
    expect(() =>
      validateApprovalPolicy({
        ...policy,
        bands: [
          policy.bands[0]!,
          { ...policy.bands[1]!, minAtomicAmount: "50002" },
          policy.bands[2]!,
        ],
      }),
    ).toThrow(/contiguous/);
    expect(() =>
      validateApprovalPolicy({
        ...policy,
        bands: [
          {
            ...policy.bands[0]!,
            requirements: [
              { role: "MANAGER", count: 1, allowSelfApproval: false },
            ],
          },
          policy.bands[1]!,
          policy.bands[2]!,
        ],
      }),
    ).toThrow(/Automatic/);
    expect(() =>
      resolveApprovalBand(policy, createMoney("USDC", "50000", 6)),
    ).toThrow(/same asset and scale/);
  });
});
