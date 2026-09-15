import type { SerializedMoney } from "./money.ts";
import type { DistributionInstruction } from "./settlement-distribution.ts";

export type RuleScalar = string | boolean;

export type SettlementRuleCondition =
  | Readonly<{
      fact: string;
      operator: "EQUALS";
      value: RuleScalar;
    }>
  | Readonly<{
      fact: string;
      operator: "IN";
      values: readonly RuleScalar[];
    }>
  | Readonly<{
      fact: string;
      operator: "EXISTS";
    }>
  | Readonly<{
      fact: string;
      operator: "MONEY_AT_LEAST" | "MONEY_AT_MOST";
      value: SerializedMoney;
    }>;

export type SettlementRuleVersion = Readonly<{
  id: string;
  ruleId: string;
  version: number;
  triggerEventType: string;
  triggerSchemaVersion: number;
  conditions: readonly SettlementRuleCondition[];
  beneficiaries: readonly DistributionInstruction[];
  approvalPolicyVersionId?: string;
  providerPolicy: Readonly<{
    providerKey: string;
    network: string;
    method: "INDIVIDUAL_TRANSFERS" | "ATOMIC_BATCH";
  }>;
  effectiveFrom: string;
  effectiveTo?: string;
  priority: number;
}>;
