import { describe, expect, it } from "vitest";

import {
  createMoney,
  evaluateApprovals,
  type ApprovalDecision,
  type ApprovalPolicyVersion,
} from "./index.ts";

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

function decision(
  actorId: string,
  actorRoles: readonly string[],
  value: ApprovalDecision["decision"] = "APPROVED",
): ApprovalDecision {
  return {
    actorId,
    actorRoles,
    decision: value,
    decidedAt: "2026-09-14T08:00:00Z",
  };
}

describe("approval evaluation", () => {
  it("automatically approves only the configured lower band", () => {
    expect(
      evaluateApprovals({
        policy,
        amount: createMoney("USD", "50000", 2),
        initiatedBy: "operator-1",
        decisions: [],
      }).outcome,
    ).toBe("AUTOMATICALLY_APPROVED");
  });

  it("enforces maker-checker and remains pending for self approval", () => {
    const result = evaluateApprovals({
      policy,
      amount: createMoney("USD", "50001", 2),
      initiatedBy: "manager-1",
      decisions: [decision("manager-1", ["MANAGER"])],
    });

    expect(result.outcome).toBe("PENDING");
    expect(result.requirements[0]).toMatchObject({
      approvedBy: [],
      remaining: 1,
    });
  });

  it("requires distinct actors for multi-approval thresholds", () => {
    const pending = evaluateApprovals({
      policy,
      amount: createMoney("USD", "500001", 2),
      initiatedBy: "operator-1",
      decisions: [decision("finance-1", ["FINANCE"])],
    });
    expect(pending.outcome).toBe("PENDING");
    expect(pending.requirements[0]?.remaining).toBe(1);

    const approved = evaluateApprovals({
      policy,
      amount: createMoney("USD", "500001", 2),
      initiatedBy: "operator-1",
      decisions: [
        decision("finance-1", ["FINANCE"]),
        decision("finance-2", ["FINANCE"]),
      ],
    });
    expect(approved.outcome).toBe("APPROVED");
    expect(approved.requirements[0]?.approvedBy).toEqual([
      "finance-1",
      "finance-2",
    ]);
  });

  it("finds a valid distinct assignment when actors have multiple roles", () => {
    const multiRolePolicy: ApprovalPolicyVersion = {
      ...policy,
      bands: [
        {
          minAtomicAmount: "0",
          maxAtomicAmount: null,
          mode: "APPROVAL_REQUIRED",
          requirements: [
            { role: "MANAGER", count: 1, allowSelfApproval: false },
            { role: "FINANCE", count: 1, allowSelfApproval: false },
          ],
        },
      ],
    };
    const result = evaluateApprovals({
      policy: multiRolePolicy,
      amount: createMoney("USD", "100", 2),
      initiatedBy: "operator-1",
      decisions: [
        decision("dual-role", ["MANAGER", "FINANCE"]),
        decision("manager-only", ["MANAGER"]),
      ],
    });

    expect(result.outcome).toBe("APPROVED");
    expect(result.requirements).toMatchObject([
      { approvedBy: ["manager-only"], remaining: 0 },
      { approvedBy: ["dual-role"], remaining: 0 },
    ]);
  });

  it("makes rejection explicit even when enough approvals exist", () => {
    const result = evaluateApprovals({
      policy,
      amount: createMoney("USD", "50001", 2),
      initiatedBy: "operator-1",
      decisions: [
        decision("manager-1", ["MANAGER"]),
        decision("manager-2", ["MANAGER"], "REJECTED"),
      ],
    });

    expect(result.outcome).toBe("REJECTED");
    expect(result.rejectedBy).toEqual(["manager-2"]);
  });

  it("rejects duplicate actor decisions and decisions on automatic bands", () => {
    expect(() =>
      evaluateApprovals({
        policy,
        amount: createMoney("USD", "50001", 2),
        initiatedBy: "operator-1",
        decisions: [
          decision("manager-1", ["MANAGER"]),
          decision("manager-1", ["MANAGER"], "REJECTED"),
        ],
      }),
    ).toThrow(/only one decision/);
    expect(() =>
      evaluateApprovals({
        policy,
        amount: createMoney("USD", "50000", 2),
        initiatedBy: "operator-1",
        decisions: [decision("manager-1", ["MANAGER"])],
      }),
    ).toThrow(/does not accept manual decisions/);
  });
});
