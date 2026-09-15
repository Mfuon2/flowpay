import { createMoney, parseAtomicAmount, type Money } from "./money.ts";

const BASIS_POINT_DENOMINATOR = 10_000n;

type InstructionBase = Readonly<{
  beneficiaryId: string;
}>;

export type PercentageInstruction = InstructionBase &
  Readonly<{
    kind: "PERCENTAGE";
    basisPoints: number;
  }>;

export type FixedInstruction = InstructionBase &
  Readonly<{
    kind: "FIXED";
    atomicAmount: string;
  }>;

export type RemainderInstruction = InstructionBase &
  Readonly<{
    kind: "REMAINDER";
  }>;

export type DistributionInstruction =
  | PercentageInstruction
  | FixedInstruction
  | RemainderInstruction;

export type CalculatedDistribution = Readonly<{
  beneficiaryId: string;
  instructionKind: DistributionInstruction["kind"];
  amount: Money;
  roundingAdjustmentAtomic: string;
}>;

export type DistributionCalculation = Readonly<{
  total: Money;
  distributions: readonly CalculatedDistribution[];
}>;

export class DistributionCalculationError extends Error {
  override readonly name = "DistributionCalculationError";
}

type WorkingDistribution = {
  instruction: DistributionInstruction;
  index: number;
  baseAmount: bigint;
  roundingRemainder: bigint;
  roundingAdjustment: bigint;
};

export function calculateDistributions(
  total: Money,
  instructions: readonly DistributionInstruction[],
): DistributionCalculation {
  validateDistributionInstructions(instructions);

  const working: WorkingDistribution[] = instructions.map(
    (instruction, index) => {
      if (instruction.kind === "FIXED") {
        return {
          instruction,
          index,
          baseAmount: parseAtomicAmount(instruction.atomicAmount),
          roundingRemainder: 0n,
          roundingAdjustment: 0n,
        };
      }
      if (instruction.kind === "PERCENTAGE") {
        const numerator = total.atomicAmount * BigInt(instruction.basisPoints);
        return {
          instruction,
          index,
          baseAmount: numerator / BASIS_POINT_DENOMINATOR,
          roundingRemainder: numerator % BASIS_POINT_DENOMINATOR,
          roundingAdjustment: 0n,
        };
      }
      return {
        instruction,
        index,
        baseAmount: 0n,
        roundingRemainder: 0n,
        roundingAdjustment: 0n,
      };
    },
  );

  const remainderDistribution = working.find(
    ({ instruction }) => instruction.kind === "REMAINDER",
  );
  const nonRemainderTotal = working.reduce(
    (sum, item) =>
      item.instruction.kind === "REMAINDER" ? sum : sum + item.baseAmount,
    0n,
  );

  if (nonRemainderTotal > total.atomicAmount) {
    throw new DistributionCalculationError(
      "Distribution instructions exceed the settlement amount.",
    );
  }

  if (remainderDistribution) {
    remainderDistribution.baseAmount = total.atomicAmount - nonRemainderTotal;
  } else {
    validateFullyAllocatedWithoutRemainder(total, working);
    allocateRoundingResidual(total.atomicAmount - nonRemainderTotal, working);
  }

  const distributions = working
    .sort((first, second) => first.index - second.index)
    .map(({ instruction, baseAmount, roundingAdjustment }) => ({
      beneficiaryId: instruction.beneficiaryId,
      instructionKind: instruction.kind,
      amount: createMoney(
        total.assetCode,
        baseAmount + roundingAdjustment,
        total.scale,
      ),
      roundingAdjustmentAtomic: roundingAdjustment.toString(),
    }));

  const calculatedTotal = distributions.reduce(
    (sum, distribution) => sum + distribution.amount.atomicAmount,
    0n,
  );
  if (calculatedTotal !== total.atomicAmount) {
    throw new DistributionCalculationError(
      "Calculated distributions do not equal the settlement amount.",
    );
  }

  return { total, distributions };
}

export function validateDistributionInstructions(
  instructions: readonly DistributionInstruction[],
): void {
  if (instructions.length === 0) {
    throw new DistributionCalculationError(
      "At least one beneficiary is required.",
    );
  }

  const beneficiaries = new Set<string>();
  let remainderCount = 0;
  for (const instruction of instructions) {
    if (instruction.beneficiaryId.trim().length === 0) {
      throw new DistributionCalculationError("Beneficiary ID cannot be empty.");
    }
    if (beneficiaries.has(instruction.beneficiaryId)) {
      throw new DistributionCalculationError(
        "Each beneficiary may appear only once.",
      );
    }
    beneficiaries.add(instruction.beneficiaryId);

    if (
      instruction.kind === "PERCENTAGE" &&
      (!Number.isSafeInteger(instruction.basisPoints) ||
        instruction.basisPoints <= 0 ||
        instruction.basisPoints > 10_000)
    ) {
      throw new DistributionCalculationError(
        "Percentage basis points must be an integer from 1 through 10,000.",
      );
    }
    if (instruction.kind === "FIXED") {
      try {
        parseAtomicAmount(instruction.atomicAmount);
      } catch (error) {
        throw new DistributionCalculationError(
          error instanceof Error ? error.message : "Invalid fixed amount.",
        );
      }
    }
    if (instruction.kind === "REMAINDER") remainderCount += 1;
  }

  if (remainderCount > 1) {
    throw new DistributionCalculationError(
      "Only one remainder beneficiary is allowed.",
    );
  }
}

function validateFullyAllocatedWithoutRemainder(
  total: Money,
  working: readonly WorkingDistribution[],
): void {
  const fixedAtomic = working.reduce(
    (sum, item) =>
      item.instruction.kind === "FIXED" ? sum + item.baseAmount : sum,
    0n,
  );
  const percentageBasisPoints = working.reduce(
    (sum, item) =>
      item.instruction.kind === "PERCENTAGE"
        ? sum + BigInt(item.instruction.basisPoints)
        : sum,
    0n,
  );
  const instructedNumerator =
    fixedAtomic * BASIS_POINT_DENOMINATOR +
    total.atomicAmount * percentageBasisPoints;
  const requiredNumerator = total.atomicAmount * BASIS_POINT_DENOMINATOR;

  if (instructedNumerator !== requiredNumerator) {
    throw new DistributionCalculationError(
      "Instructions must allocate the full amount or include a remainder beneficiary.",
    );
  }
}

function allocateRoundingResidual(
  residual: bigint,
  working: WorkingDistribution[],
): void {
  if (residual === 0n) return;

  const candidates = working
    .filter(({ instruction }) => instruction.kind === "PERCENTAGE")
    .sort(
      (first, second) =>
        Number(second.roundingRemainder - first.roundingRemainder) ||
        first.index - second.index,
    );

  if (residual > BigInt(candidates.length)) {
    throw new DistributionCalculationError(
      "Rounding residual cannot be allocated safely.",
    );
  }

  for (let index = 0; index < Number(residual); index += 1) {
    const candidate = candidates[index];
    if (!candidate) {
      throw new DistributionCalculationError(
        "Rounding beneficiary is missing.",
      );
    }
    candidate.roundingAdjustment = 1n;
  }
}
