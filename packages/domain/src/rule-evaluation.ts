import { deserializeMoney, type SerializedMoney } from "./money.ts";
import type {
  RuleScalar,
  SettlementRuleCondition,
  SettlementRuleVersion,
} from "./settlement-rule.ts";

export type RuleFactValue = RuleScalar | SerializedMoney;
export type RuleFacts = Readonly<Record<string, RuleFactValue>>;

export type ConditionEvaluation = Readonly<{
  condition: SettlementRuleCondition;
  passed: boolean;
  actual?: RuleFactValue;
  reason: string;
}>;

export type RuleCandidateEvaluation = Readonly<{
  ruleVersionId: string;
  priority: number;
  eligible: boolean;
  matched: boolean;
  reason: string;
  conditions: readonly ConditionEvaluation[];
}>;

type RuleSelectionBase = Readonly<{
  evaluations: readonly RuleCandidateEvaluation[];
}>;

export type RuleSelection =
  | (RuleSelectionBase & Readonly<{ outcome: "NO_MATCH" }>)
  | (RuleSelectionBase &
      Readonly<{
        outcome: "MATCHED";
        rule: SettlementRuleVersion;
      }>)
  | (RuleSelectionBase &
      Readonly<{
        outcome: "CONFLICT";
        conflictingRuleVersionIds: readonly string[];
        priority: number;
      }>);

export type RuleSelectionInput = Readonly<{
  eventType: string;
  eventSchemaVersion: number;
  occurredAt: string;
  facts: RuleFacts;
  rules: readonly SettlementRuleVersion[];
}>;

export class RuleEvaluationError extends Error {
  override readonly name = "RuleEvaluationError";
}

const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export function selectSettlementRule(input: RuleSelectionInput): RuleSelection {
  requireIdentifier("Event type", input.eventType);
  requirePositiveInteger("Event schema version", input.eventSchemaVersion);
  const occurredAt = parseUtcTimestamp("Event occurred-at", input.occurredAt);

  const evaluated = input.rules.map((rule) => {
    validateSettlementRuleVersion(rule);
    return { rule, evaluation: evaluateCandidate(input, occurredAt, rule) };
  });
  const evaluations = evaluated.map(({ evaluation }) => evaluation);
  const matches = evaluated
    .filter(({ evaluation }) => evaluation.matched)
    .sort(
      (first, second) =>
        second.rule.priority - first.rule.priority ||
        first.rule.id.localeCompare(second.rule.id),
    );

  const first = matches[0];
  if (!first) return { outcome: "NO_MATCH", evaluations };

  const highestPriorityMatches = matches.filter(
    ({ rule }) => rule.priority === first.rule.priority,
  );
  if (highestPriorityMatches.length > 1) {
    return {
      outcome: "CONFLICT",
      conflictingRuleVersionIds: highestPriorityMatches.map(
        ({ rule }) => rule.id,
      ),
      priority: first.rule.priority,
      evaluations,
    };
  }

  return { outcome: "MATCHED", rule: first.rule, evaluations };
}

export function validateSettlementRuleVersion(
  rule: SettlementRuleVersion,
): void {
  requireIdentifier("Rule version ID", rule.id);
  requireIdentifier("Rule ID", rule.ruleId);
  requirePositiveInteger("Rule version", rule.version);
  requireIdentifier("Trigger event type", rule.triggerEventType);
  requirePositiveInteger("Trigger schema version", rule.triggerSchemaVersion);
  if (!Number.isSafeInteger(rule.priority)) {
    throw new RuleEvaluationError("Rule priority must be a safe integer.");
  }
  const effectiveFrom = parseUtcTimestamp(
    "Rule effective-from",
    rule.effectiveFrom,
  );
  if (rule.effectiveTo !== undefined) {
    const effectiveTo = parseUtcTimestamp(
      "Rule effective-to",
      rule.effectiveTo,
    );
    if (effectiveTo <= effectiveFrom) {
      throw new RuleEvaluationError(
        "Rule effective-to must be later than effective-from.",
      );
    }
  }
  requireIdentifier("Provider key", rule.providerPolicy.providerKey);
  requireIdentifier("Provider network", rule.providerPolicy.network);
  if (rule.beneficiaries.length === 0) {
    throw new RuleEvaluationError("Rule requires at least one beneficiary.");
  }

  const beneficiaries = new Set<string>();
  for (const beneficiary of rule.beneficiaries) {
    requireIdentifier("Beneficiary ID", beneficiary.beneficiaryId);
    if (beneficiaries.has(beneficiary.beneficiaryId)) {
      throw new RuleEvaluationError(
        "A beneficiary may appear only once in a rule version.",
      );
    }
    beneficiaries.add(beneficiary.beneficiaryId);
  }

  for (const condition of rule.conditions) validateCondition(condition);
}

function evaluateCandidate(
  input: RuleSelectionInput,
  occurredAt: number,
  rule: SettlementRuleVersion,
): RuleCandidateEvaluation {
  if (
    rule.triggerEventType !== input.eventType ||
    rule.triggerSchemaVersion !== input.eventSchemaVersion
  ) {
    return ineligible(rule, "Event trigger or schema version does not match.");
  }

  const effectiveFrom = Date.parse(rule.effectiveFrom);
  const effectiveTo =
    rule.effectiveTo === undefined ? undefined : Date.parse(rule.effectiveTo);
  if (
    occurredAt < effectiveFrom ||
    (effectiveTo !== undefined && occurredAt >= effectiveTo)
  ) {
    return ineligible(
      rule,
      "Event occurred outside the rule effective window.",
    );
  }

  const conditions = rule.conditions.map((condition) =>
    evaluateCondition(condition, input.facts),
  );
  const matched = conditions.every(({ passed }) => passed);
  return {
    ruleVersionId: rule.id,
    priority: rule.priority,
    eligible: true,
    matched,
    reason: matched
      ? "All conditions matched."
      : "One or more conditions failed.",
    conditions,
  };
}

function ineligible(
  rule: SettlementRuleVersion,
  reason: string,
): RuleCandidateEvaluation {
  return {
    ruleVersionId: rule.id,
    priority: rule.priority,
    eligible: false,
    matched: false,
    reason,
    conditions: [],
  };
}

function evaluateCondition(
  condition: SettlementRuleCondition,
  facts: RuleFacts,
): ConditionEvaluation {
  const exists = Object.hasOwn(facts, condition.fact);
  const actual = facts[condition.fact];
  if (condition.operator === "EXISTS") {
    return {
      condition,
      passed: exists,
      ...(actual === undefined ? {} : { actual }),
      reason: exists ? "Fact exists." : "Fact is absent.",
    };
  }
  if (!exists || actual === undefined) {
    return { condition, passed: false, reason: "Fact is absent." };
  }

  if (condition.operator === "EQUALS") {
    const passed = isScalar(actual) && actual === condition.value;
    return {
      condition,
      actual,
      passed,
      reason: passed
        ? "Fact equals expected value."
        : "Fact does not equal expected value.",
    };
  }
  if (condition.operator === "IN") {
    const passed =
      isScalar(actual) && condition.values.some((value) => value === actual);
    return {
      condition,
      actual,
      passed,
      reason: passed
        ? "Fact is in the allowed set."
        : "Fact is not in the allowed set.",
    };
  }

  if (!isSerializedMoney(actual)) {
    return {
      condition,
      actual,
      passed: false,
      reason: "Fact is not an exact money value.",
    };
  }
  const actualMoney = deserializeMoney(actual);
  const expectedMoney = deserializeMoney(condition.value);
  if (
    actualMoney.assetCode !== expectedMoney.assetCode ||
    actualMoney.scale !== expectedMoney.scale
  ) {
    return {
      condition,
      actual,
      passed: false,
      reason: "Money asset or scale does not match.",
    };
  }
  const passed =
    condition.operator === "MONEY_AT_LEAST"
      ? actualMoney.atomicAmount >= expectedMoney.atomicAmount
      : actualMoney.atomicAmount <= expectedMoney.atomicAmount;
  return {
    condition,
    actual,
    passed,
    reason: passed ? "Money threshold passed." : "Money threshold failed.",
  };
}

function validateCondition(condition: SettlementRuleCondition): void {
  requireIdentifier("Condition fact", condition.fact);
  if (condition.operator === "IN" && condition.values.length === 0) {
    throw new RuleEvaluationError("IN conditions require at least one value.");
  }
  if (
    condition.operator === "MONEY_AT_LEAST" ||
    condition.operator === "MONEY_AT_MOST"
  ) {
    deserializeMoney(condition.value);
  }
}

function isScalar(value: RuleFactValue): value is RuleScalar {
  return typeof value === "string" || typeof value === "boolean";
}

function isSerializedMoney(value: RuleFactValue): value is SerializedMoney {
  return typeof value === "object";
}

function requireIdentifier(label: string, value: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new RuleEvaluationError(
      `${label} must be a non-empty trimmed string.`,
    );
  }
}

function requirePositiveInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RuleEvaluationError(`${label} must be a positive integer.`);
  }
}

function parseUtcTimestamp(label: string, value: string): number {
  const parsed = Date.parse(value);
  if (!UTC_TIMESTAMP.test(value) || !Number.isFinite(parsed)) {
    throw new RuleEvaluationError(
      `${label} must be an ISO 8601 UTC timestamp.`,
    );
  }
  return parsed;
}
