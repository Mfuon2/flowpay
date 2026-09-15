import { describe, expect, it } from "vitest";

import {
  EscrowConfigurationError,
  InvalidEscrowTransitionError,
  allowedEscrowActions,
  createMoney,
  transitionEscrow,
  validateEscrowMilestones,
} from "./index.ts";

const milestones = [
  {
    id: "milestone-1",
    position: 0,
    name: "Foundation complete",
    verificationEventType: "MILESTONE_VERIFIED",
    releaseAmount: { assetCode: "USD", atomicAmount: "60000", scale: 2 },
  },
  {
    id: "milestone-2",
    position: 1,
    name: "Structure complete",
    verificationEventType: "MILESTONE_VERIFIED",
    releaseAmount: { assetCode: "USD", atomicAmount: "80000", scale: 2 },
  },
  {
    id: "milestone-3",
    position: 2,
    name: "Final completion",
    verificationEventType: "MILESTONE_VERIFIED",
    releaseAmount: { assetCode: "USD", atomicAmount: "60000", scale: 2 },
  },
] as const;

describe("escrow milestone configuration", () => {
  it("requires exact allocation in the same asset and precision", () => {
    expect(() =>
      validateEscrowMilestones(createMoney("USD", "200000", 2), milestones),
    ).not.toThrow();
    expect(() =>
      validateEscrowMilestones(createMoney("USD", "199999", 2), milestones),
    ).toThrow(EscrowConfigurationError);
    expect(() =>
      validateEscrowMilestones(
        createMoney("USDC", "2000000000", 6),
        milestones,
      ),
    ).toThrow(/same asset and scale/);
  });

  it("rejects duplicate identities, positions, empty plans, and zero releases", () => {
    expect(() =>
      validateEscrowMilestones(createMoney("USD", "1", 2), []),
    ).toThrow(/at least one/);
    expect(() =>
      validateEscrowMilestones(createMoney("USD", "120000", 2), [
        milestones[0],
        { ...milestones[2], id: milestones[0].id, position: 0 },
      ]),
    ).toThrow(/IDs must be unique|positions must be unique/);
    expect(() =>
      validateEscrowMilestones(createMoney("USD", "0", 2), [
        {
          ...milestones[0],
          releaseAmount: { assetCode: "USD", atomicAmount: "0", scale: 2 },
        },
      ]),
    ).toThrow(/greater than zero/);
  });
});

describe("escrow state transitions", () => {
  it("supports controlled funding, partial release, dispute, and completion", () => {
    expect(transitionEscrow("DRAFT", "ACTIVATE")).toBe("AWAITING_FUNDING");
    expect(transitionEscrow("AWAITING_FUNDING", "CONFIRM_FUNDING")).toBe(
      "FUNDED",
    );
    expect(transitionEscrow("FUNDED", "RELEASE_PARTIAL")).toBe(
      "PARTIALLY_RELEASED",
    );
    expect(transitionEscrow("PARTIALLY_RELEASED", "OPEN_DISPUTE")).toBe(
      "DISPUTED",
    );
    expect(transitionEscrow("DISPUTED", "RESOLVE_TO_PARTIALLY_RELEASED")).toBe(
      "PARTIALLY_RELEASED",
    );
    expect(transitionEscrow("PARTIALLY_RELEASED", "RELEASE_FINAL")).toBe(
      "RELEASED",
    );
    expect(allowedEscrowActions("RELEASED")).toEqual([]);
  });

  it("does not allow release before funding or mutation after completion", () => {
    expect(() => transitionEscrow("DRAFT", "RELEASE_FINAL")).toThrow(
      InvalidEscrowTransitionError,
    );
    expect(() => transitionEscrow("RELEASED", "CANCEL")).toThrow(
      InvalidEscrowTransitionError,
    );
  });
});
