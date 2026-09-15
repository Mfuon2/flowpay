import {
  resolveApprovalBand,
  type ApprovalBand,
  type ApprovalPolicyVersion,
  type ApprovalRequirement,
} from "./approval-policy.ts";
import type { Money } from "./money.ts";

export type ApprovalDecision = Readonly<{
  actorId: string;
  actorRoles: readonly string[];
  decision: "APPROVED" | "REJECTED";
  decidedAt: string;
}>;

export type RequirementSatisfaction = Readonly<{
  requirement: ApprovalRequirement;
  approvedBy: readonly string[];
  remaining: number;
}>;

export type ApprovalEvaluation = Readonly<{
  outcome:
    | "AUTOMATICALLY_APPROVED"
    | "MANUAL_ACTION_REQUIRED"
    | "PENDING"
    | "APPROVED"
    | "REJECTED";
  band: ApprovalBand;
  requirements: readonly RequirementSatisfaction[];
  rejectedBy: readonly string[];
}>;

export type ApprovalEvaluationInput = Readonly<{
  policy: ApprovalPolicyVersion;
  amount: Money;
  initiatedBy: string;
  decisions: readonly ApprovalDecision[];
}>;

export class ApprovalEvaluationError extends Error {
  override readonly name = "ApprovalEvaluationError";
}

const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export function evaluateApprovals(
  input: ApprovalEvaluationInput,
): ApprovalEvaluation {
  requireIdentifier("Initiating actor", input.initiatedBy);
  validateDecisions(input.decisions);
  const band = resolveApprovalBand(input.policy, input.amount);

  if (band.mode === "AUTOMATIC") {
    if (input.decisions.length > 0) {
      throw new ApprovalEvaluationError(
        "Automatic approval does not accept manual decisions.",
      );
    }
    return {
      outcome: "AUTOMATICALLY_APPROVED",
      band,
      requirements: [],
      rejectedBy: [],
    };
  }
  if (band.mode === "MANUAL") {
    return {
      outcome: "MANUAL_ACTION_REQUIRED",
      band,
      requirements: [],
      rejectedBy: input.decisions
        .filter(({ decision }) => decision === "REJECTED")
        .map(({ actorId }) => actorId),
    };
  }

  const rejectedBy = input.decisions
    .filter(({ decision }) => decision === "REJECTED")
    .map(({ actorId }) => actorId);
  const eligibleApprovals = input.decisions.filter(
    ({ decision }) => decision === "APPROVED",
  );
  const assignments = assignDistinctApprovers(
    band.requirements,
    eligibleApprovals,
    input.initiatedBy,
  );
  const requirements = band.requirements.map((requirement, index) => {
    const approvedBy = assignments[index] ?? [];
    return {
      requirement,
      approvedBy,
      remaining: requirement.count - approvedBy.length,
    };
  });

  return {
    outcome:
      rejectedBy.length > 0
        ? "REJECTED"
        : requirements.every(({ remaining }) => remaining === 0)
          ? "APPROVED"
          : "PENDING",
    band,
    requirements,
    rejectedBy,
  };
}

function assignDistinctApprovers(
  requirements: readonly ApprovalRequirement[],
  decisions: readonly ApprovalDecision[],
  initiatedBy: string,
): readonly (readonly string[])[] {
  const slots = requirements.flatMap((requirement, requirementIndex) =>
    Array.from({ length: requirement.count }, () => ({
      requirement,
      requirementIndex,
    })),
  );
  const actorIndexBySlot = slots.map(() => -1);

  function assign(actorIndex: number, visitedSlots: Set<number>): boolean {
    const decision = decisions[actorIndex];
    if (!decision) return false;
    for (const [slotIndex, slot] of slots.entries()) {
      if (
        visitedSlots.has(slotIndex) ||
        !decision.actorRoles.includes(slot.requirement.role) ||
        (!slot.requirement.allowSelfApproval &&
          decision.actorId === initiatedBy)
      ) {
        continue;
      }
      visitedSlots.add(slotIndex);
      const assignedActorIndex = actorIndexBySlot[slotIndex];
      if (
        assignedActorIndex === undefined ||
        assignedActorIndex === -1 ||
        assign(assignedActorIndex, visitedSlots)
      ) {
        actorIndexBySlot[slotIndex] = actorIndex;
        return true;
      }
    }
    return false;
  }

  for (const actorIndex of decisions.keys()) {
    assign(actorIndex, new Set<number>());
  }

  const assignments = requirements.map(() => [] as string[]);
  for (const [slotIndex, actorIndex] of actorIndexBySlot.entries()) {
    if (actorIndex === -1) continue;
    const slot = slots[slotIndex];
    const decision = decisions[actorIndex];
    if (slot && decision) {
      assignments[slot.requirementIndex]?.push(decision.actorId);
    }
  }
  const decisionOrder = new Map(
    decisions.map(({ actorId }, index) => [actorId, index]),
  );
  for (const assignedActors of assignments) {
    assignedActors.sort(
      (first, second) =>
        (decisionOrder.get(first) ?? 0) - (decisionOrder.get(second) ?? 0),
    );
  }
  return assignments;
}

function validateDecisions(decisions: readonly ApprovalDecision[]): void {
  const actors = new Set<string>();
  for (const decision of decisions) {
    requireIdentifier("Decision actor", decision.actorId);
    if (actors.has(decision.actorId)) {
      throw new ApprovalEvaluationError(
        "An actor may have only one decision per approval request.",
      );
    }
    actors.add(decision.actorId);
    if (decision.actorRoles.length === 0) {
      throw new ApprovalEvaluationError(
        "Approval decisions require at least one actor role.",
      );
    }
    const roles = new Set<string>();
    for (const role of decision.actorRoles) {
      requireIdentifier("Decision actor role", role);
      if (roles.has(role)) {
        throw new ApprovalEvaluationError(
          "Decision actor roles must be unique.",
        );
      }
      roles.add(role);
    }
    if (
      !UTC_TIMESTAMP.test(decision.decidedAt) ||
      !Number.isFinite(Date.parse(decision.decidedAt))
    ) {
      throw new ApprovalEvaluationError(
        "Decision timestamp must be an ISO 8601 UTC timestamp.",
      );
    }
  }
}

function requireIdentifier(label: string, value: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new ApprovalEvaluationError(
      `${label} must be a non-empty trimmed string.`,
    );
  }
}
