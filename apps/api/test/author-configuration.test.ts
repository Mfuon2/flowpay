import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  ConfigurationUnavailableError,
  createApprovalPolicy,
  createSettlementRule,
  transitionConfiguration,
} from "../src/flowpay/author-configuration.ts";

const now = "2026-09-14T12:00:00Z";

async function fixture(suffix: string) {
  const organisationId = `org-configuration-${suffix}`;
  await env.DB.prepare(
    "INSERT INTO organisations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
  )
    .bind(organisationId, `Configuration ${suffix}`, now, now)
    .run();
  const participantIds = ["workshop", "mechanic", "referrer"].map(
    (name) => `${name}-configuration-${suffix}`,
  );
  await env.DB.batch(
    participantIds.map((id) =>
      env.DB.prepare(
        `INSERT INTO participants (
          id, organisation_id, display_name, participant_type, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'CONTRACTOR', 'ACTIVE', ?, ?)`,
      ).bind(id, organisationId, id, now, now),
    ),
  );
  return { organisationId, participantIds };
}

describe("financial configuration authoring", () => {
  it("creates immutable versions and activates policy before rule", async () => {
    const { organisationId, participantIds } = await fixture("lifecycle");
    const policyCommand = {
      commandId: "create-policy-lifecycle",
      organisationId,
      actorId: "finance-admin",
      correlationId: "configuration-lifecycle",
      name: "Controlled settlement approval",
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
          maxAtomicAmount: null,
          mode: "APPROVAL_REQUIRED",
          requirements: [
            { role: "FINANCE", count: 1, allowSelfApproval: false },
          ],
        },
      ],
    } as const;
    const policy = await createApprovalPolicy(env.DB, policyCommand);
    await expect(createApprovalPolicy(env.DB, policyCommand)).resolves.toEqual({
      ...policy,
      replayed: true,
    });
    const rule = await createSettlementRule(env.DB, {
      commandId: "create-rule-lifecycle",
      organisationId,
      actorId: "finance-admin",
      correlationId: "configuration-lifecycle",
      name: "Generic partner split",
      triggerEventType: "PAYMENT_CONFIRMED",
      triggerSchemaVersion: 1,
      priority: 100,
      effectiveFrom: now,
      conditions: [
        { fact: "job.status", operator: "EQUALS", value: "COMPLETED" },
      ],
      beneficiaries: [
        {
          kind: "PERCENTAGE",
          beneficiaryId: participantIds[0]!,
          basisPoints: 2500,
        },
        {
          kind: "PERCENTAGE",
          beneficiaryId: participantIds[1]!,
          basisPoints: 7000,
        },
        { kind: "REMAINDER", beneficiaryId: participantIds[2]! },
      ],
      providerPolicy: {
        providerKey: "simulation",
        network: "simnet",
        method: "INDIVIDUAL_TRANSFERS",
      },
      approvalPolicyVersionId: policy.versionId,
    });
    await expect(
      transitionConfiguration(env.DB, {
        commandId: "activate-rule-too-soon",
        organisationId,
        actorId: "finance-admin",
        correlationId: "configuration-lifecycle",
        configurationType: "SETTLEMENT_RULE",
        configurationId: rule.id,
        action: "ACTIVATE",
        occurredAt: "2026-09-14T12:01:00Z",
      }),
    ).rejects.toBeInstanceOf(ConfigurationUnavailableError);
    const activation = {
      commandId: "activate-policy-lifecycle",
      organisationId,
      actorId: "finance-reviewer",
      correlationId: "configuration-lifecycle",
      configurationType: "APPROVAL_POLICY",
      configurationId: policy.id,
      action: "ACTIVATE",
      occurredAt: "2026-09-14T12:02:00Z",
    } as const;
    await expect(
      transitionConfiguration(env.DB, activation),
    ).resolves.toMatchObject({
      status: "ACTIVE",
      replayed: false,
    });
    await expect(
      transitionConfiguration(env.DB, activation),
    ).resolves.toMatchObject({
      status: "ACTIVE",
      replayed: true,
    });
    await expect(
      transitionConfiguration(env.DB, {
        ...activation,
        commandId: "activate-rule-lifecycle",
        configurationType: "SETTLEMENT_RULE",
        configurationId: rule.id,
        occurredAt: "2026-09-14T12:03:00Z",
      }),
    ).resolves.toMatchObject({ status: "ACTIVE" });
    await expect(
      env.DB.prepare(
        "UPDATE settlement_rules SET status = 'INACTIVE' WHERE id = ?",
      )
        .bind(rule.id)
        .run(),
    ).rejects.toThrow(/transition must be recorded/);
    await expect(
      env.DB.prepare(
        "UPDATE settlement_rule_versions SET priority = 1 WHERE id = ?",
      )
        .bind(rule.versionId)
        .run(),
    ).rejects.toThrow(/immutable/);
  });

  it("rejects invalid approval gaps and invalid distribution instructions", async () => {
    const { organisationId, participantIds } = await fixture("invalid");
    await expect(
      createApprovalPolicy(env.DB, {
        commandId: "invalid-policy",
        organisationId,
        actorId: "finance-admin",
        correlationId: "invalid-configuration",
        name: "Invalid",
        assetCode: "USD",
        assetScale: 2,
        bands: [
          {
            minAtomicAmount: "1",
            maxAtomicAmount: null,
            mode: "AUTOMATIC",
            requirements: [],
          },
        ],
      }),
    ).rejects.toThrow(/start at zero/);
    const policy = await createApprovalPolicy(env.DB, {
      commandId: "valid-policy-invalid-rule",
      organisationId,
      actorId: "finance-admin",
      correlationId: "invalid-configuration",
      name: "Valid",
      assetCode: "USD",
      assetScale: 2,
      bands: [
        {
          minAtomicAmount: "0",
          maxAtomicAmount: null,
          mode: "AUTOMATIC",
          requirements: [],
        },
      ],
    });
    await expect(
      createSettlementRule(env.DB, {
        commandId: "invalid-rule",
        organisationId,
        actorId: "finance-admin",
        correlationId: "invalid-configuration",
        name: "Invalid split",
        triggerEventType: "PAYMENT_CONFIRMED",
        triggerSchemaVersion: 1,
        priority: 1,
        effectiveFrom: now,
        conditions: [],
        beneficiaries: [
          {
            kind: "PERCENTAGE",
            beneficiaryId: participantIds[0]!,
            basisPoints: 10001,
          },
        ],
        providerPolicy: {
          providerKey: "simulation",
          network: "simnet",
          method: "INDIVIDUAL_TRANSFERS",
        },
        approvalPolicyVersionId: policy.versionId,
      }),
    ).rejects.toThrow(/basis points/);
  });
});
