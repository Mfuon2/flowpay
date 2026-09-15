export const SETTLEMENT_STATES = [
  "DRAFT",
  "PENDING_RULE_EVALUATION",
  "PENDING_APPROVAL",
  "READY",
  "SUBMITTING",
  "SUBMITTED",
  "CONFIRMED",
  "FAILED",
  "CANCELLED",
  "REVERSED",
] as const;

export type SettlementState = (typeof SETTLEMENT_STATES)[number];

export const SETTLEMENT_ACTIONS = [
  "BEGIN_RULE_EVALUATION",
  "REQUIRE_APPROVAL",
  "MARK_READY",
  "BEGIN_SUBMISSION",
  "ACCEPT_SUBMISSION",
  "CONFIRM",
  "FAIL",
  "CANCEL",
  "RETRY",
  "REVERSE",
] as const;

export type SettlementAction = (typeof SETTLEMENT_ACTIONS)[number];

const TRANSITIONS: Readonly<
  Record<
    SettlementState,
    Readonly<Partial<Record<SettlementAction, SettlementState>>>
  >
> = {
  DRAFT: {
    BEGIN_RULE_EVALUATION: "PENDING_RULE_EVALUATION",
    CANCEL: "CANCELLED",
  },
  PENDING_RULE_EVALUATION: {
    REQUIRE_APPROVAL: "PENDING_APPROVAL",
    MARK_READY: "READY",
    FAIL: "FAILED",
    CANCEL: "CANCELLED",
  },
  PENDING_APPROVAL: {
    MARK_READY: "READY",
    FAIL: "FAILED",
    CANCEL: "CANCELLED",
  },
  READY: {
    BEGIN_SUBMISSION: "SUBMITTING",
    CANCEL: "CANCELLED",
  },
  SUBMITTING: {
    ACCEPT_SUBMISSION: "SUBMITTED",
    CONFIRM: "CONFIRMED",
    FAIL: "FAILED",
  },
  SUBMITTED: {
    CONFIRM: "CONFIRMED",
    FAIL: "FAILED",
  },
  CONFIRMED: {
    REVERSE: "REVERSED",
  },
  FAILED: {
    RETRY: "READY",
  },
  CANCELLED: {},
  REVERSED: {},
};

export class InvalidSettlementTransitionError extends Error {
  override readonly name = "InvalidSettlementTransitionError";

  constructor(
    readonly currentState: SettlementState,
    readonly action: SettlementAction,
  ) {
    super(
      `Action ${action} is not allowed from settlement state ${currentState}.`,
    );
  }
}

export function transitionSettlement(
  currentState: SettlementState,
  action: SettlementAction,
): SettlementState {
  const nextState = TRANSITIONS[currentState][action];
  if (!nextState) {
    throw new InvalidSettlementTransitionError(currentState, action);
  }
  return nextState;
}

export function allowedSettlementActions(
  currentState: SettlementState,
): readonly SettlementAction[] {
  return SETTLEMENT_ACTIONS.filter(
    (action) => TRANSITIONS[currentState][action],
  );
}
