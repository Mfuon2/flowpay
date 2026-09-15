import {
  assertSameAsset,
  createMoney,
  parseAtomicAmount,
  type Money,
} from "./money.ts";

export const APPROVAL_MODES = [
  "AUTOMATIC",
  "MANUAL",
  "APPROVAL_REQUIRED",
] as const;

export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export type ApprovalRequirement = Readonly<{
  role: string;
  count: number;
  allowSelfApproval: boolean;
}>;

export type ApprovalBand = Readonly<{
  minAtomicAmount: string;
  maxAtomicAmount: string | null;
  mode: ApprovalMode;
  requirements: readonly ApprovalRequirement[];
}>;

export type ApprovalPolicyVersion = Readonly<{
  id: string;
  policyId: string;
  version: number;
  assetCode: string;
  assetScale: number;
  bands: readonly ApprovalBand[];
}>;

export class ApprovalPolicyError extends Error {
  override readonly name = "ApprovalPolicyError";
}

export function validateApprovalPolicy(policy: ApprovalPolicyVersion): void {
  if (!Number.isSafeInteger(policy.version) || policy.version < 1) {
    throw new ApprovalPolicyError("Policy version must be a positive integer.");
  }
  createMoney(policy.assetCode, 0n, policy.assetScale);
  if (policy.bands.length === 0) {
    throw new ApprovalPolicyError(
      "Approval policy requires at least one band.",
    );
  }

  let expectedMinimum = 0n;
  for (const [index, band] of policy.bands.entries()) {
    const minimum = parseAtomicAmount(band.minAtomicAmount);
    const maximum =
      band.maxAtomicAmount === null
        ? null
        : parseAtomicAmount(band.maxAtomicAmount);

    if (minimum !== expectedMinimum) {
      throw new ApprovalPolicyError(
        "Approval bands must be ordered, contiguous, and start at zero.",
      );
    }
    if (maximum !== null && maximum < minimum) {
      throw new ApprovalPolicyError(
        "Approval band maximum cannot be below its minimum.",
      );
    }
    if (maximum === null && index !== policy.bands.length - 1) {
      throw new ApprovalPolicyError(
        "Only the final approval band may have no maximum.",
      );
    }

    if (band.mode === "AUTOMATIC" && band.requirements.length > 0) {
      throw new ApprovalPolicyError(
        "Automatic approval bands cannot contain approver requirements.",
      );
    }
    if (band.mode === "APPROVAL_REQUIRED" && band.requirements.length === 0) {
      throw new ApprovalPolicyError(
        "Approval-required bands need at least one approver requirement.",
      );
    }
    for (const requirement of band.requirements) {
      if (requirement.role.trim().length === 0) {
        throw new ApprovalPolicyError("Approver role cannot be empty.");
      }
      if (!Number.isSafeInteger(requirement.count) || requirement.count < 1) {
        throw new ApprovalPolicyError(
          "Approver count must be a positive integer.",
        );
      }
    }

    if (maximum === null) return;
    expectedMinimum = maximum + 1n;
  }

  throw new ApprovalPolicyError(
    "The final approval band must cover all higher amounts.",
  );
}

export function resolveApprovalBand(
  policy: ApprovalPolicyVersion,
  amount: Money,
): ApprovalBand {
  validateApprovalPolicy(policy);
  assertSameAsset(amount, createMoney(policy.assetCode, 0n, policy.assetScale));

  const band = policy.bands.find((candidate) => {
    const minimum = parseAtomicAmount(candidate.minAtomicAmount);
    const maximum =
      candidate.maxAtomicAmount === null
        ? null
        : parseAtomicAmount(candidate.maxAtomicAmount);
    return (
      amount.atomicAmount >= minimum &&
      (maximum === null || amount.atomicAmount <= maximum)
    );
  });

  if (!band) {
    throw new ApprovalPolicyError("No approval band covers this amount.");
  }
  return band;
}
