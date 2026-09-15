import type {
  ApprovalPolicyVersion,
  ApprovalRequirement,
  DistributionInstruction,
  RuleScalar,
  SerializedMoney,
  SettlementRuleCondition,
  SettlementRuleVersion,
} from "@flowpay/domain";

export class StoredConfigurationError extends Error {
  override readonly name = "StoredConfigurationError";
}

export type SettlementRuleRow = Readonly<{
  id: string;
  rule_id: string;
  version: number;
  trigger_event_type: string;
  trigger_schema_version: number;
  priority: number;
  effective_from: string;
  effective_to: string | null;
  conditions_json: string;
  beneficiaries_json: string;
  provider_policy_json: string;
  approval_policy_version_id: string | null;
}>;

export function parseSettlementRuleRow(
  row: SettlementRuleRow,
): SettlementRuleVersion {
  const conditions = parseJson(row.conditions_json, "rule conditions");
  const beneficiaries = parseJson(row.beneficiaries_json, "rule beneficiaries");
  const providerPolicy = parseJson(
    row.provider_policy_json,
    "rule provider policy",
  );
  if (!Array.isArray(conditions)) {
    throw invalid("Rule conditions must be an array.");
  }
  if (!Array.isArray(beneficiaries)) {
    throw invalid("Rule beneficiaries must be an array.");
  }
  if (!isRecord(providerPolicy)) {
    throw invalid("Rule provider policy must be an object.");
  }

  return {
    id: row.id,
    ruleId: row.rule_id,
    version: row.version,
    triggerEventType: row.trigger_event_type,
    triggerSchemaVersion: row.trigger_schema_version,
    conditions: conditions.map(parseCondition),
    beneficiaries: beneficiaries.map(parseDistributionInstruction),
    ...(row.approval_policy_version_id === null
      ? {}
      : { approvalPolicyVersionId: row.approval_policy_version_id }),
    providerPolicy: parseProviderPolicy(providerPolicy),
    effectiveFrom: row.effective_from,
    ...(row.effective_to === null ? {} : { effectiveTo: row.effective_to }),
    priority: row.priority,
  };
}

export function parseApprovalPolicy(policyJson: string): ApprovalPolicyVersion {
  const value = parseJson(policyJson, "approval policy");
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !isString(value.policyId) ||
    !isNumber(value.version) ||
    !isString(value.assetCode) ||
    !isNumber(value.assetScale) ||
    !Array.isArray(value.bands)
  ) {
    throw invalid("Stored approval policy has an invalid shape.");
  }

  return {
    id: value.id,
    policyId: value.policyId,
    version: value.version,
    assetCode: value.assetCode,
    assetScale: value.assetScale,
    bands: value.bands.map((band) => {
      if (
        !isRecord(band) ||
        !isString(band.minAtomicAmount) ||
        !(band.maxAtomicAmount === null || isString(band.maxAtomicAmount)) ||
        !isApprovalMode(band.mode) ||
        !Array.isArray(band.requirements)
      ) {
        throw invalid("Stored approval band has an invalid shape.");
      }
      return {
        minAtomicAmount: band.minAtomicAmount,
        maxAtomicAmount: band.maxAtomicAmount,
        mode: band.mode,
        requirements: band.requirements.map(parseApprovalRequirement),
      };
    }),
  };
}

function parseCondition(value: unknown): SettlementRuleCondition {
  if (!isRecord(value) || !isString(value.fact) || !isString(value.operator)) {
    throw invalid("Stored rule condition has an invalid shape.");
  }
  if (value.operator === "EXISTS") {
    return { fact: value.fact, operator: value.operator };
  }
  if (value.operator === "EQUALS" && isRuleScalar(value.value)) {
    return { fact: value.fact, operator: value.operator, value: value.value };
  }
  if (
    value.operator === "IN" &&
    Array.isArray(value.values) &&
    value.values.every(isRuleScalar)
  ) {
    return { fact: value.fact, operator: value.operator, values: value.values };
  }
  if (
    (value.operator === "MONEY_AT_LEAST" ||
      value.operator === "MONEY_AT_MOST") &&
    isSerializedMoney(value.value)
  ) {
    return { fact: value.fact, operator: value.operator, value: value.value };
  }
  throw invalid("Stored rule condition uses an invalid operator or value.");
}

function parseDistributionInstruction(value: unknown): DistributionInstruction {
  if (
    !isRecord(value) ||
    !isString(value.kind) ||
    !isString(value.beneficiaryId)
  ) {
    throw invalid("Stored beneficiary instruction has an invalid shape.");
  }
  if (value.kind === "REMAINDER") {
    return { kind: value.kind, beneficiaryId: value.beneficiaryId };
  }
  if (value.kind === "PERCENTAGE" && isNumber(value.basisPoints)) {
    return {
      kind: value.kind,
      beneficiaryId: value.beneficiaryId,
      basisPoints: value.basisPoints,
    };
  }
  if (value.kind === "FIXED" && isString(value.atomicAmount)) {
    return {
      kind: value.kind,
      beneficiaryId: value.beneficiaryId,
      atomicAmount: value.atomicAmount,
    };
  }
  throw invalid("Stored beneficiary instruction has invalid calculation data.");
}

function parseProviderPolicy(value: Record<string, unknown>): {
  providerKey: string;
  network: string;
  method: "INDIVIDUAL_TRANSFERS" | "ATOMIC_BATCH";
} {
  if (
    !isString(value.providerKey) ||
    !isString(value.network) ||
    (value.method !== "INDIVIDUAL_TRANSFERS" && value.method !== "ATOMIC_BATCH")
  ) {
    throw invalid("Stored provider policy has an invalid shape.");
  }
  return {
    providerKey: value.providerKey,
    network: value.network,
    method: value.method,
  };
}

function parseApprovalRequirement(value: unknown): ApprovalRequirement {
  if (
    !isRecord(value) ||
    !isString(value.role) ||
    !isNumber(value.count) ||
    typeof value.allowSelfApproval !== "boolean"
  ) {
    throw invalid("Stored approval requirement has an invalid shape.");
  }
  return {
    role: value.role,
    count: value.count,
    allowSelfApproval: value.allowSelfApproval,
  };
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw invalid(`Stored ${label} is not valid JSON.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function isRuleScalar(value: unknown): value is RuleScalar {
  return typeof value === "string" || typeof value === "boolean";
}

function isSerializedMoney(value: unknown): value is SerializedMoney {
  return (
    isRecord(value) &&
    isString(value.assetCode) &&
    isString(value.atomicAmount) &&
    isNumber(value.scale)
  );
}

function isApprovalMode(
  value: unknown,
): value is "AUTOMATIC" | "MANUAL" | "APPROVAL_REQUIRED" {
  return (
    value === "AUTOMATIC" || value === "MANUAL" || value === "APPROVAL_REQUIRED"
  );
}

function invalid(message: string): StoredConfigurationError {
  return new StoredConfigurationError(message);
}
