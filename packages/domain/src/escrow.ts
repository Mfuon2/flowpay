import {
  assertSameAsset,
  deserializeMoney,
  type Money,
  type SerializedMoney,
} from "./money.ts";

export const ESCROW_STATES = [
  "DRAFT",
  "AWAITING_FUNDING",
  "FUNDED",
  "PARTIALLY_RELEASED",
  "RELEASED",
  "DISPUTED",
  "CANCELLED",
] as const;

export type EscrowState = (typeof ESCROW_STATES)[number];

export const ESCROW_ACTIONS = [
  "ACTIVATE",
  "CONFIRM_FUNDING",
  "RELEASE_PARTIAL",
  "RELEASE_FINAL",
  "OPEN_DISPUTE",
  "RESOLVE_TO_FUNDED",
  "RESOLVE_TO_PARTIALLY_RELEASED",
  "CANCEL",
] as const;

export type EscrowAction = (typeof ESCROW_ACTIONS)[number];

export type EscrowMilestoneDefinition = Readonly<{
  id: string;
  position: number;
  name: string;
  verificationEventType: string;
  releaseAmount: SerializedMoney;
}>;

const TRANSITIONS: Readonly<
  Record<EscrowState, Readonly<Partial<Record<EscrowAction, EscrowState>>>>
> = {
  DRAFT: { ACTIVATE: "AWAITING_FUNDING", CANCEL: "CANCELLED" },
  AWAITING_FUNDING: { CONFIRM_FUNDING: "FUNDED", CANCEL: "CANCELLED" },
  FUNDED: {
    RELEASE_PARTIAL: "PARTIALLY_RELEASED",
    RELEASE_FINAL: "RELEASED",
    OPEN_DISPUTE: "DISPUTED",
    CANCEL: "CANCELLED",
  },
  PARTIALLY_RELEASED: {
    RELEASE_PARTIAL: "PARTIALLY_RELEASED",
    RELEASE_FINAL: "RELEASED",
    OPEN_DISPUTE: "DISPUTED",
  },
  DISPUTED: {
    RESOLVE_TO_FUNDED: "FUNDED",
    RESOLVE_TO_PARTIALLY_RELEASED: "PARTIALLY_RELEASED",
    CANCEL: "CANCELLED",
  },
  RELEASED: {},
  CANCELLED: {},
};

export class EscrowConfigurationError extends Error {
  override readonly name = "EscrowConfigurationError";
}

export class InvalidEscrowTransitionError extends Error {
  override readonly name = "InvalidEscrowTransitionError";

  constructor(
    readonly currentState: EscrowState,
    readonly action: EscrowAction,
  ) {
    super(`Action ${action} is not allowed from escrow state ${currentState}.`);
  }
}

export function validateEscrowMilestones(
  total: Money,
  milestones: readonly EscrowMilestoneDefinition[],
): void {
  if (milestones.length === 0) {
    throw new EscrowConfigurationError(
      "Escrow requires at least one release milestone.",
    );
  }
  const ids = new Set<string>();
  const positions = new Set<number>();
  let allocated = 0n;
  for (const milestone of milestones) {
    requireIdentifier("Milestone ID", milestone.id);
    requireIdentifier("Milestone name", milestone.name);
    requireIdentifier(
      "Milestone verification event type",
      milestone.verificationEventType,
    );
    if (ids.has(milestone.id)) {
      throw new EscrowConfigurationError("Milestone IDs must be unique.");
    }
    if (
      !Number.isSafeInteger(milestone.position) ||
      milestone.position < 0 ||
      positions.has(milestone.position)
    ) {
      throw new EscrowConfigurationError(
        "Milestone positions must be unique non-negative integers.",
      );
    }
    const amount = deserializeMoney(milestone.releaseAmount);
    assertSameAsset(total, amount);
    if (amount.atomicAmount === 0n) {
      throw new EscrowConfigurationError(
        "Milestone release amounts must be greater than zero.",
      );
    }
    ids.add(milestone.id);
    positions.add(milestone.position);
    allocated += amount.atomicAmount;
  }
  if (allocated !== total.atomicAmount) {
    throw new EscrowConfigurationError(
      "Milestone release amounts must equal the escrow total exactly.",
    );
  }
}

export function transitionEscrow(
  currentState: EscrowState,
  action: EscrowAction,
): EscrowState {
  const next = TRANSITIONS[currentState][action];
  if (!next) throw new InvalidEscrowTransitionError(currentState, action);
  return next;
}

export function allowedEscrowActions(
  currentState: EscrowState,
): readonly EscrowAction[] {
  return ESCROW_ACTIONS.filter((action) => TRANSITIONS[currentState][action]);
}

function requireIdentifier(label: string, value: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new EscrowConfigurationError(
      `${label} must be a non-empty trimmed string.`,
    );
  }
}
