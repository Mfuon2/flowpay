import { env } from "cloudflare:workers";
import {
  SimulationSettlementProvider,
  type SimulationBehavior,
} from "@flowpay/provider-simulation";
import type { SettlementProvider } from "@flowpay/provider-contract";
import { describe, expect, it } from "vitest";

import {
  EventReplayConflictError,
  FlowPayConfigurationError,
  recordBusinessEvent,
  type RecordBusinessEventCommand,
} from "../src/flowpay/process-business-event.ts";
import {
  SettlementExecutionUnavailableError,
  executeSettlementWorkItem,
} from "../src/flowpay/execute-settlement-work-item.ts";
import { observeProviderTransaction } from "../src/flowpay/observe-provider-transaction.ts";
import { processDueSettlementWork } from "../src/flowpay/process-due-settlement-work.ts";
import { processDueProviderObservations } from "../src/flowpay/process-due-provider-observations.ts";
import {
  SettlementRecoveryConflictError,
  recordSettlementRecovery,
} from "../src/flowpay/record-settlement-recovery.ts";
import {
  JournalPostingConflictError,
  postJournal,
} from "../src/accounting/post-journal.ts";
import {
  ReconciliationConflictError,
  reconcileDistribution,
} from "../src/accounting/reconcile-distribution.ts";
import { processAccountingWorkItem } from "../src/accounting/process-accounting-work-item.ts";
import {
  PaymentConfirmationConflictError,
  confirmPayment,
} from "../src/business/confirm-payment.ts";
import { processPaymentConfirmedMessage } from "../src/business/process-payment-confirmed-message.ts";
import {
  ApprovalDecisionConflictError,
  ApprovalDecisionNotAuthorizedError,
  recordApprovalDecision,
} from "../src/flowpay/record-approval-decision.ts";
import {
  MANUAL_SETTLEMENT_PERMISSION,
  ManualSettlementControlConflictError,
  ManualSettlementControlNotAuthorizedError,
  recordManualSettlementControl,
} from "../src/flowpay/record-manual-settlement-control.ts";
import {
  PermanentQueueMessageError,
  consumeFlowPayMessage,
  recordPermanentQueueFailure,
} from "../src/messaging/consumer.ts";
import {
  dispatchPendingOutbox,
  type FlowPayQueueMessage,
  type FlowPayQueueSender,
} from "../src/messaging/outbox.ts";

const now = "2026-09-14T12:00:00Z";

type SeedOptions = Readonly<{
  suffix: string;
  automaticMaximum?: string;
  missingBeneficiary?: boolean;
  conflictingRule?: boolean;
  approvalCount?: number;
  approvalRole?: string;
  manualMode?: boolean;
}>;

async function seedConfiguration(options: SeedOptions): Promise<{
  organisationId: string;
  ruleVersionId: string;
}> {
  const organisationId = `org-${options.suffix}`;
  const policyId = `policy-${options.suffix}`;
  const policyVersionId = `policy-version-${options.suffix}`;
  const ruleId = `rule-${options.suffix}`;
  const ruleVersionId = `rule-version-${options.suffix}`;
  const beneficiaries = ["workshop", "mechanic", "referrer"].map(
    (name) => `${name}-${options.suffix}`,
  );
  const policy = {
    id: policyVersionId,
    policyId,
    version: 1,
    assetCode: "USD",
    assetScale: 2,
    bands: options.manualMode
      ? [
          {
            minAtomicAmount: "0",
            maxAtomicAmount: null,
            mode: "MANUAL",
            requirements: [],
          },
        ]
      : [
          {
            minAtomicAmount: "0",
            maxAtomicAmount: options.automaticMaximum ?? "50000",
            mode: "AUTOMATIC",
            requirements: [],
          },
          {
            minAtomicAmount: String(
              BigInt(options.automaticMaximum ?? "50000") + 1n,
            ),
            maxAtomicAmount: null,
            mode: "APPROVAL_REQUIRED",
            requirements: [
              {
                role: options.approvalRole ?? "MANAGER",
                count: options.approvalCount ?? 1,
                allowSelfApproval: false,
              },
            ],
          },
        ],
  };
  const conditions = [
    { fact: "job.status", operator: "EQUALS", value: "COMPLETED" },
    {
      fact: "payment.amount",
      operator: "MONEY_AT_LEAST",
      value: { assetCode: "USD", atomicAmount: "1", scale: 2 },
    },
  ];
  const beneficiaryInstructions = [
    {
      kind: "PERCENTAGE",
      beneficiaryId: beneficiaries[0],
      basisPoints: 2500,
    },
    {
      kind: "PERCENTAGE",
      beneficiaryId: beneficiaries[1],
      basisPoints: 7000,
    },
    {
      kind: "PERCENTAGE",
      beneficiaryId: beneficiaries[2],
      basisPoints: 500,
    },
  ];
  const participantStatements = beneficiaries
    .filter((_, index) => !(options.missingBeneficiary && index === 2))
    .map((id) =>
      env.DB.prepare(
        `INSERT INTO participants (
          id, organisation_id, display_name, participant_type, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'CONTRACTOR', 'ACTIVE', ?, ?)`,
      ).bind(id, organisationId, id, now, now),
    );

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organisations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(organisationId, `Organisation ${options.suffix}`, now, now),
    ...participantStatements,
    env.DB.prepare(
      `INSERT INTO approval_policies (
        id, organisation_id, name, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
    ).bind(policyId, organisationId, `Policy ${options.suffix}`, now, now),
    env.DB.prepare(
      `INSERT INTO approval_policy_versions (
        id, policy_id, version, policy_json, created_by, created_at
      ) VALUES (?, ?, 1, ?, 'seed', ?)`,
    ).bind(policyVersionId, policyId, JSON.stringify(policy), now),
    env.DB.prepare(
      `INSERT INTO settlement_rules (
        id, organisation_id, name, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
    ).bind(ruleId, organisationId, `Rule ${options.suffix}`, now, now),
    ruleVersionStatement({
      id: ruleVersionId,
      ruleId,
      policyVersionId,
      priority: 100,
      conditions,
      beneficiaries: beneficiaryInstructions,
    }),
    ...(options.conflictingRule
      ? [
          env.DB.prepare(
            `INSERT INTO settlement_rules (
              id, organisation_id, name, status, created_at, updated_at
            ) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
          ).bind(
            `${ruleId}-conflict`,
            organisationId,
            `Conflicting rule ${options.suffix}`,
            now,
            now,
          ),
          ruleVersionStatement({
            id: `${ruleVersionId}-conflict`,
            ruleId: `${ruleId}-conflict`,
            policyVersionId,
            priority: 100,
            conditions,
            beneficiaries: beneficiaryInstructions,
          }),
        ]
      : []),
  ]);

  return { organisationId, ruleVersionId };
}

function ruleVersionStatement(input: {
  id: string;
  ruleId: string;
  policyVersionId: string;
  priority: number;
  conditions: readonly unknown[];
  beneficiaries: readonly unknown[];
}): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO settlement_rule_versions (
      id, rule_id, version, trigger_event_type, trigger_schema_version,
      priority, effective_from, conditions_json, beneficiaries_json,
      provider_policy_json, approval_policy_version_id, created_by, created_at
    ) VALUES (?, ?, 1, 'PAYMENT_CONFIRMED', 1, ?, ?, ?, ?, ?, ?, 'seed', ?)`,
  ).bind(
    input.id,
    input.ruleId,
    input.priority,
    "2026-09-01T00:00:00Z",
    JSON.stringify(input.conditions),
    JSON.stringify(input.beneficiaries),
    JSON.stringify({
      providerKey: "simulation",
      network: "simnet",
      method: "INDIVIDUAL_TRANSFERS",
    }),
    input.policyVersionId,
    now,
  );
}

function command(
  organisationId: string,
  suffix: string,
): RecordBusinessEventCommand {
  return {
    event: {
      id: `event-${suffix}`,
      organisationId,
      source: "workshop-demo",
      externalEventId: `payment-${suffix}-confirmed`,
      eventType: "PAYMENT_CONFIRMED",
      schemaVersion: 1,
      aggregateType: "PAYMENT",
      aggregateId: `payment-${suffix}`,
      occurredAt: "2026-09-14T11:59:00Z",
      recordedAt: now,
      correlationId: `correlation-${suffix}`,
      payload: { paymentId: `payment-${suffix}`, amountAtomic: "100000" },
    },
    facts: {
      "job.status": "COMPLETED",
      "payment.amount": {
        assetCode: "USD",
        atomicAmount: "100000",
        scale: 2,
      },
    },
    settlementAmount: {
      assetCode: "USD",
      atomicAmount: "100000",
      scale: 2,
    },
    initiatedBy: "workshop-event-adapter",
  };
}

describe("recordBusinessEvent", () => {
  it("atomically records the flagship settlement and approval evidence", async () => {
    const seeded = await seedConfiguration({ suffix: "flagship" });
    const result = await recordBusinessEvent(
      env.DB,
      command(seeded.organisationId, "flagship"),
    );

    expect(result).toMatchObject({
      replayed: false,
      outcome: "MATCHED",
      settlement: { state: "PENDING_APPROVAL" },
    });
    const distributions = await env.DB.prepare(
      `SELECT beneficiary_id, amount_atomic
       FROM settlement_distributions
       WHERE settlement_id = ? ORDER BY position`,
    )
      .bind(result.settlement?.id)
      .all<{ beneficiary_id: string; amount_atomic: string }>();
    expect(
      distributions.results.map(({ amount_atomic }) => amount_atomic),
    ).toEqual(["25000", "70000", "5000"]);

    const approval = await env.DB.prepare(
      "SELECT status, requirements_json FROM approval_requests WHERE settlement_id = ?",
    )
      .bind(result.settlement?.id)
      .first<{ status: string; requirements_json: string }>();
    expect(approval?.status).toBe("PENDING");
    expect(JSON.parse(approval?.requirements_json ?? "{}")).toMatchObject({
      mode: "APPROVAL_REQUIRED",
      requirements: [{ role: "MANAGER", count: 1 }],
    });

    const evidence = await env.DB.prepare(
      "SELECT outcome, matched_rule_version_id FROM rule_evaluations WHERE business_event_id = ?",
    )
      .bind(result.eventId)
      .first<{ outcome: string; matched_rule_version_id: string }>();
    expect(evidence).toEqual({
      outcome: "MATCHED",
      matched_rule_version_id: seeded.ruleVersionId,
    });
    const deduplicationHash = await env.DB.prepare(
      "SELECT deduplication_hash FROM business_events WHERE id = ?",
    )
      .bind(result.eventId)
      .first<string>("deduplication_hash");
    expect(deduplicationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE organisation_id = ?",
      )
        .bind(seeded.organisationId)
        .first<number>("count"),
    ).toBe(2);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM outbox_messages WHERE organisation_id = ?",
      )
        .bind(seeded.organisationId)
        .first<number>("count"),
    ).toBe(2);
  });

  it("returns the original result for an identical replay", async () => {
    const seeded = await seedConfiguration({ suffix: "replay" });
    const original = await recordBusinessEvent(
      env.DB,
      command(seeded.organisationId, "replay"),
    );
    const replayed = await recordBusinessEvent(
      env.DB,
      command(seeded.organisationId, "replay"),
    );

    expect(replayed).toEqual({ ...original, replayed: true });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM settlements WHERE organisation_id = ?",
      )
        .bind(seeded.organisationId)
        .first<number>("count"),
    ).toBe(1);
  });

  it("rejects reuse of an event identity with different business data", async () => {
    const seeded = await seedConfiguration({ suffix: "conflict-replay" });
    const original = command(seeded.organisationId, "conflict-replay");
    await recordBusinessEvent(env.DB, original);

    await expect(
      recordBusinessEvent(env.DB, {
        ...original,
        settlementAmount: {
          ...original.settlementAmount,
          atomicAmount: "99999",
        },
      }),
    ).rejects.toBeInstanceOf(EventReplayConflictError);
  });

  it("persists no-match and equal-priority conflict outcomes without settlement", async () => {
    const noMatchSeed = await seedConfiguration({ suffix: "no-match" });
    const noMatchCommand = command(noMatchSeed.organisationId, "no-match");
    const noMatch = await recordBusinessEvent(env.DB, {
      ...noMatchCommand,
      facts: { ...noMatchCommand.facts, "job.status": "STARTED" },
    });
    expect(noMatch).toMatchObject({ outcome: "NO_MATCH", replayed: false });
    expect(noMatch.settlement).toBeUndefined();

    const conflictSeed = await seedConfiguration({
      suffix: "rule-conflict",
      conflictingRule: true,
    });
    const conflict = await recordBusinessEvent(
      env.DB,
      command(conflictSeed.organisationId, "rule-conflict"),
    );
    expect(conflict).toMatchObject({ outcome: "CONFLICT", replayed: false });
    expect(conflict.settlement).toBeUndefined();
  });

  it("moves automatic settlements directly to ready with resolved approval evidence", async () => {
    const seeded = await seedConfiguration({
      suffix: "automatic",
      automaticMaximum: "100000",
    });
    const result = await recordBusinessEvent(
      env.DB,
      command(seeded.organisationId, "automatic"),
    );

    expect(result.settlement?.state).toBe("READY");
    const approval = await env.DB.prepare(
      "SELECT status, resolved_at FROM approval_requests WHERE settlement_id = ?",
    )
      .bind(result.settlement?.id)
      .first<{ status: string; resolved_at: string | null }>();
    expect(approval?.status).toBe("APPROVED");
    expect(approval?.resolved_at).not.toBeNull();
  });

  it("rolls back the event when a beneficiary is not active in the organisation", async () => {
    const seeded = await seedConfiguration({
      suffix: "missing-beneficiary",
      missingBeneficiary: true,
    });
    await expect(
      recordBusinessEvent(
        env.DB,
        command(seeded.organisationId, "missing-beneficiary"),
      ),
    ).rejects.toBeInstanceOf(FlowPayConfigurationError);

    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM business_events WHERE organisation_id = ?",
      )
        .bind(seeded.organisationId)
        .first<number>("count"),
    ).toBe(0);
  });
});

describe("recordApprovalDecision", () => {
  it("records approval once and moves the settlement to ready", async () => {
    const seeded = await seedConfiguration({ suffix: "approve" });
    const eventResult = await recordBusinessEvent(
      env.DB,
      command(seeded.organisationId, "approve"),
    );
    const approvalCommand = {
      decisionId: "decision-approve",
      organisationId: seeded.organisationId,
      settlementId: eventResult.settlement?.id ?? "missing",
      actorId: "manager-1",
      actorRoles: ["MANAGER"],
      decision: "APPROVE",
    } as const;

    const result = await recordApprovalDecision(env.DB, approvalCommand);
    expect(result).toMatchObject({
      replayed: false,
      approvalOutcome: "APPROVED",
      decisionVersion: 1,
      settlement: { state: "READY", stateVersion: 1 },
    });
    const replay = await recordApprovalDecision(env.DB, approvalCommand);
    expect(replay).toEqual({ ...result, replayed: true });

    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM approval_decisions WHERE approval_request_id = ?",
      )
        .bind(result.approvalRequestId)
        .first<number>("count"),
    ).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM settlement_state_transitions WHERE settlement_id = ?",
      )
        .bind(result.settlement.id)
        .first<number>("count"),
    ).toBe(1);
  });

  it("keeps partial multi-approver decisions pending, then becomes ready", async () => {
    const seeded = await seedConfiguration({
      suffix: "two-approvers",
      approvalCount: 2,
      approvalRole: "FINANCE",
    });
    const eventResult = await recordBusinessEvent(
      env.DB,
      command(seeded.organisationId, "two-approvers"),
    );
    const settlementId = eventResult.settlement?.id ?? "missing";
    const first = await recordApprovalDecision(env.DB, {
      decisionId: "decision-finance-1",
      organisationId: seeded.organisationId,
      settlementId,
      actorId: "finance-1",
      actorRoles: ["FINANCE"],
      decision: "APPROVE",
    });
    expect(first).toMatchObject({
      approvalOutcome: "PENDING",
      decisionVersion: 1,
      settlement: { state: "PENDING_APPROVAL", stateVersion: 0 },
    });

    const second = await recordApprovalDecision(env.DB, {
      decisionId: "decision-finance-2",
      organisationId: seeded.organisationId,
      settlementId,
      actorId: "finance-2",
      actorRoles: ["FINANCE"],
      decision: "APPROVE",
    });
    expect(second).toMatchObject({
      approvalOutcome: "APPROVED",
      decisionVersion: 2,
      settlement: { state: "READY", stateVersion: 1 },
    });
  });

  it("serializes concurrent approvals without losing either decision", async () => {
    const seeded = await seedConfiguration({
      suffix: "concurrent-approvers",
      approvalCount: 2,
      approvalRole: "FINANCE",
    });
    const eventResult = await recordBusinessEvent(
      env.DB,
      command(seeded.organisationId, "concurrent-approvers"),
    );
    const settlementId = eventResult.settlement?.id ?? "missing";
    const results = await Promise.all([
      recordApprovalDecision(env.DB, {
        decisionId: "decision-concurrent-1",
        organisationId: seeded.organisationId,
        settlementId,
        actorId: "finance-concurrent-1",
        actorRoles: ["FINANCE"],
        decision: "APPROVE",
      }),
      recordApprovalDecision(env.DB, {
        decisionId: "decision-concurrent-2",
        organisationId: seeded.organisationId,
        settlementId,
        actorId: "finance-concurrent-2",
        actorRoles: ["FINANCE"],
        decision: "APPROVE",
      }),
    ]);

    expect(
      results.map(({ approvalOutcome }) => approvalOutcome).sort(),
    ).toEqual(["APPROVED", "PENDING"]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM approval_decisions WHERE approval_request_id = ?",
      )
        .bind(results[0]?.approvalRequestId)
        .first<number>("count"),
    ).toBe(2);
  });

  it("rejects with a reason and cancels the settlement visibly", async () => {
    const seeded = await seedConfiguration({ suffix: "reject" });
    const eventResult = await recordBusinessEvent(
      env.DB,
      command(seeded.organisationId, "reject"),
    );
    const result = await recordApprovalDecision(env.DB, {
      decisionId: "decision-reject",
      organisationId: seeded.organisationId,
      settlementId: eventResult.settlement?.id ?? "missing",
      actorId: "manager-reject",
      actorRoles: ["MANAGER"],
      decision: "REJECT",
      reason: "Supporting evidence is incomplete.",
    });

    expect(result).toMatchObject({
      approvalOutcome: "REJECTED",
      settlement: { state: "CANCELLED", stateVersion: 1 },
    });
    const transition = await env.DB.prepare(
      "SELECT action, reason FROM settlement_state_transitions WHERE settlement_id = ?",
    )
      .bind(result.settlement.id)
      .first<{ action: string; reason: string }>();
    expect(transition).toEqual({
      action: "CANCEL",
      reason: "Supporting evidence is incomplete.",
    });
  });

  it("enforces role authorization and maker-checker", async () => {
    const seeded = await seedConfiguration({ suffix: "approval-auth" });
    const eventResult = await recordBusinessEvent(
      env.DB,
      command(seeded.organisationId, "approval-auth"),
    );
    const settlementId = eventResult.settlement?.id ?? "missing";

    await expect(
      recordApprovalDecision(env.DB, {
        decisionId: "decision-wrong-role",
        organisationId: seeded.organisationId,
        settlementId,
        actorId: "accountant-1",
        actorRoles: ["ACCOUNTANT"],
        decision: "APPROVE",
      }),
    ).rejects.toBeInstanceOf(ApprovalDecisionNotAuthorizedError);
    await expect(
      recordApprovalDecision(env.DB, {
        decisionId: "decision-self-approval",
        organisationId: seeded.organisationId,
        settlementId,
        actorId: "workshop-event-adapter",
        actorRoles: ["MANAGER"],
        decision: "APPROVE",
      }),
    ).rejects.toBeInstanceOf(ApprovalDecisionNotAuthorizedError);
  });

  it("rejects a changed retry and direct unaudited state mutation", async () => {
    const seeded = await seedConfiguration({
      suffix: "approval-conflict",
      approvalCount: 2,
    });
    const eventResult = await recordBusinessEvent(
      env.DB,
      command(seeded.organisationId, "approval-conflict"),
    );
    const settlementId = eventResult.settlement?.id ?? "missing";
    await recordApprovalDecision(env.DB, {
      decisionId: "decision-stable",
      organisationId: seeded.organisationId,
      settlementId,
      actorId: "manager-stable",
      actorRoles: ["MANAGER"],
      decision: "APPROVE",
    });
    await expect(
      recordApprovalDecision(env.DB, {
        decisionId: "decision-changed",
        organisationId: seeded.organisationId,
        settlementId,
        actorId: "manager-stable",
        actorRoles: ["MANAGER"],
        decision: "REJECT",
        reason: "Changed decision.",
      }),
    ).rejects.toBeInstanceOf(ApprovalDecisionConflictError);

    await expect(
      env.DB.prepare(
        "UPDATE settlements SET state = 'READY', state_version = 1 WHERE id = ?",
      )
        .bind(settlementId)
        .run(),
    ).rejects.toThrow(/unaudited settlement state transition/);
  });
});

describe("recordManualSettlementControl", () => {
  it("releases a manual settlement exactly once with explicit permission", async () => {
    const seeded = await seedConfiguration({
      suffix: "manual-release",
      manualMode: true,
    });
    const eventResult = await recordBusinessEvent(
      env.DB,
      command(seeded.organisationId, "manual-release"),
    );
    expect(eventResult.settlement?.state).toBe("PENDING_APPROVAL");
    const control = {
      commandId: "manual-release-command",
      organisationId: seeded.organisationId,
      settlementId: eventResult.settlement?.id ?? "missing",
      actorId: "finance-operator",
      actorPermissions: [MANUAL_SETTLEMENT_PERMISSION],
      action: "RELEASE",
      reason: "Verified for manual release.",
    } as const;

    const result = await recordManualSettlementControl(env.DB, control);
    expect(result).toMatchObject({
      replayed: false,
      settlement: { state: "READY", stateVersion: 1 },
    });
    await expect(
      recordManualSettlementControl(env.DB, control),
    ).resolves.toEqual({ ...result, replayed: true });
  });

  it("collapses concurrent identical manual releases into one transition", async () => {
    const seeded = await seedConfiguration({
      suffix: "manual-concurrent",
      manualMode: true,
    });
    const eventResult = await recordBusinessEvent(
      env.DB,
      command(seeded.organisationId, "manual-concurrent"),
    );
    const control = {
      commandId: "manual-concurrent-command",
      organisationId: seeded.organisationId,
      settlementId: eventResult.settlement?.id ?? "missing",
      actorId: "finance-operator",
      actorPermissions: [MANUAL_SETTLEMENT_PERMISSION],
      action: "RELEASE",
    } as const;

    const results = await Promise.all([
      recordManualSettlementControl(env.DB, control),
      recordManualSettlementControl(env.DB, control),
    ]);
    expect(results.map(({ replayed }) => replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM settlement_state_transitions WHERE id = ?",
      )
        .bind(control.commandId)
        .first<number>("count"),
    ).toBe(1);
  });

  it("requires trusted release permission and a cancellation reason", async () => {
    const seeded = await seedConfiguration({
      suffix: "manual-permission",
      manualMode: true,
    });
    const eventResult = await recordBusinessEvent(
      env.DB,
      command(seeded.organisationId, "manual-permission"),
    );
    const settlementId = eventResult.settlement?.id ?? "missing";
    await expect(
      recordManualSettlementControl(env.DB, {
        commandId: "manual-no-permission",
        organisationId: seeded.organisationId,
        settlementId,
        actorId: "operator",
        actorPermissions: [],
        action: "RELEASE",
      }),
    ).rejects.toBeInstanceOf(ManualSettlementControlNotAuthorizedError);
    await expect(
      recordManualSettlementControl(env.DB, {
        commandId: "manual-cancel-no-reason",
        organisationId: seeded.organisationId,
        settlementId,
        actorId: "operator",
        actorPermissions: [MANUAL_SETTLEMENT_PERMISSION],
        action: "CANCEL",
      }),
    ).rejects.toThrow(/requires a reason/);
  });

  it("cancels visibly and rejects a changed command replay", async () => {
    const seeded = await seedConfiguration({
      suffix: "manual-cancel",
      manualMode: true,
    });
    const eventResult = await recordBusinessEvent(
      env.DB,
      command(seeded.organisationId, "manual-cancel"),
    );
    const control = {
      commandId: "manual-cancel-command",
      organisationId: seeded.organisationId,
      settlementId: eventResult.settlement?.id ?? "missing",
      actorId: "finance-operator",
      actorPermissions: [MANUAL_SETTLEMENT_PERMISSION],
      action: "CANCEL",
      reason: "Commercial dispute opened.",
    } as const;
    const result = await recordManualSettlementControl(env.DB, control);
    expect(result.settlement).toMatchObject({
      state: "CANCELLED",
      stateVersion: 1,
    });

    await expect(
      recordManualSettlementControl(env.DB, {
        ...control,
        action: "RELEASE",
        reason: "Changed action.",
      }),
    ).rejects.toBeInstanceOf(ManualSettlementControlConflictError);
  });
});

describe("FlowPay queue handoff", () => {
  it("dispatches the transactional outbox and creates execution work exactly once", async () => {
    await env.DB.prepare(
      "UPDATE outbox_messages SET dispatched_at = ? WHERE dispatched_at IS NULL",
    )
      .bind(now)
      .run();
    const seeded = await seedConfiguration({
      suffix: "queue-ready",
      automaticMaximum: "100000",
    });
    const eventResult = await recordBusinessEvent(
      env.DB,
      command(seeded.organisationId, "queue-ready"),
    );
    const messages: FlowPayQueueMessage[] = [];
    const queue: FlowPayQueueSender = {
      send(body): Promise<void> {
        messages.push(body);
        return Promise.resolve();
      },
    };

    const dispatch = await dispatchPendingOutbox(env.DB, queue);
    expect(dispatch).toEqual({ selected: 3, dispatched: 3, failed: 0 });
    const ready = messages.find(
      ({ messageType }) => messageType === "FLOWPAY_SETTLEMENT_READY",
    );
    expect(ready).toBeDefined();

    await expect(consumeFlowPayMessage(env.DB, ready)).resolves.toBe(
      "PROCESSED",
    );
    await expect(consumeFlowPayMessage(env.DB, ready)).resolves.toBe(
      "DUPLICATE",
    );
    const workItem = await env.DB.prepare(
      `SELECT settlement_id, work_type, status
       FROM settlement_work_items WHERE source_message_id = ?`,
    )
      .bind(ready?.messageId)
      .first<{
        settlement_id: string;
        work_type: string;
        status: string;
      }>();
    expect(workItem).toEqual({
      settlement_id: eventResult.settlement?.id,
      work_type: "EXECUTE_SETTLEMENT",
      status: "PENDING",
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM settlement_work_items WHERE settlement_id = ?",
      )
        .bind(eventResult.settlement?.id)
        .first<number>("count"),
    ).toBe(1);
  });

  it("records retryable dispatch failures without losing the outbox message", async () => {
    await env.DB.prepare(
      "UPDATE outbox_messages SET dispatched_at = ? WHERE dispatched_at IS NULL",
    )
      .bind(now)
      .run();
    const seeded = await seedConfiguration({
      suffix: "queue-dispatch-failure",
      automaticMaximum: "100000",
    });
    await recordBusinessEvent(
      env.DB,
      command(seeded.organisationId, "queue-dispatch-failure"),
    );
    const queue: FlowPayQueueSender = {
      send(): Promise<void> {
        return Promise.reject(new Error("Queue is temporarily unavailable."));
      },
    };

    const dispatch = await dispatchPendingOutbox(env.DB, queue, 1);
    expect(dispatch).toEqual({ selected: 1, dispatched: 0, failed: 1 });
    const failed = await env.DB.prepare(
      `SELECT dispatched_at, dispatch_attempts, next_attempt_at, last_error
       FROM outbox_messages WHERE organisation_id = ?
       ORDER BY created_at, id LIMIT 1`,
    )
      .bind(seeded.organisationId)
      .first<{
        dispatched_at: string | null;
        dispatch_attempts: number;
        next_attempt_at: string | null;
        last_error: string | null;
      }>();
    expect(failed).toMatchObject({
      dispatched_at: null,
      dispatch_attempts: 1,
      last_error: "Queue is temporarily unavailable.",
    });
    expect(failed?.next_attempt_at).not.toBeNull();
  });

  it("quarantines a permanently invalid queue envelope for operations", async () => {
    const error = new PermanentQueueMessageError("Invalid test envelope.");
    await expect(
      consumeFlowPayMessage(env.DB, { messageId: "invalid" }),
    ).rejects.toBeInstanceOf(PermanentQueueMessageError);
    await recordPermanentQueueFailure(
      env.DB,
      "flowpay-events",
      "queue-invalid",
      1,
      error,
    );
    const failure = await env.DB.prepare(
      `SELECT queue_name, queue_message_id, error_code, error_message
       FROM queue_message_failures WHERE queue_message_id = ?`,
    )
      .bind("queue-invalid")
      .first<{
        queue_name: string;
        queue_message_id: string;
        error_code: string;
        error_message: string;
      }>();
    expect(failure).toEqual({
      queue_name: "flowpay-events",
      queue_message_id: "queue-invalid",
      error_code: "PermanentQueueMessageError",
      error_message: "Invalid test envelope.",
    });
  });
});

async function prepareProviderExecution(
  suffix: string,
  behavior: SimulationBehavior,
): Promise<{
  organisationId: string;
  settlementId: string;
  workItemId: string;
  provider: SimulationSettlementProvider;
}> {
  const seeded = await seedConfiguration({
    suffix,
    automaticMaximum: "100000",
  });
  const eventResult = await recordBusinessEvent(
    env.DB,
    command(seeded.organisationId, suffix),
  );
  const ready = await env.DB.prepare(
    `SELECT id AS messageId, organisation_id AS organisationId,
            message_type AS messageType, schema_version AS schemaVersion,
            aggregate_type AS aggregateType, aggregate_id AS aggregateId,
            correlation_id AS correlationId, causation_id AS causationId,
            payload_json AS payloadJson, created_at AS createdAt
     FROM outbox_messages
     WHERE organisation_id = ? AND message_type = 'FLOWPAY_SETTLEMENT_READY'`,
  )
    .bind(seeded.organisationId)
    .first<FlowPayQueueMessage>();
  if (!ready || !eventResult.settlement) {
    throw new Error(
      "Provider execution test setup did not produce a settlement.",
    );
  }
  await consumeFlowPayMessage(env.DB, ready);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO settlement_provider_sources (
        id, organisation_id, provider, network, source_reference,
        status, created_at, updated_at
      ) VALUES (?, ?, 'simulation', 'simnet', ?, 'ACTIVE', ?, ?)`,
    ).bind(
      `source-${suffix}`,
      seeded.organisationId,
      `treasury-${suffix}`,
      now,
      now,
    ),
    ...["workshop", "mechanic", "referrer"].map((participant) =>
      env.DB.prepare(
        `INSERT INTO participant_settlement_destinations (
          id, organisation_id, participant_id, provider, network, address,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, 'simulation', 'simnet', ?, 'ACTIVE', ?, ?)`,
      ).bind(
        `destination-${participant}-${suffix}`,
        seeded.organisationId,
        `${participant}-${suffix}`,
        `sim:${participant}-${suffix}`,
        now,
        now,
      ),
    ),
  ]);
  return {
    organisationId: seeded.organisationId,
    settlementId: eventResult.settlement.id,
    workItemId: ready.messageId,
    provider: new SimulationSettlementProvider(behavior),
  };
}

describe("executeSettlementWorkItem", () => {
  it("confirms every distribution and the parent using stable persisted attempts", async () => {
    const setup = await prepareProviderExecution(
      "provider-confirmed",
      "CONFIRMED",
    );
    await expect(
      executeSettlementWorkItem(
        env.DB,
        setup.workItemId,
        "simulation",
        setup.provider,
      ),
    ).resolves.toMatchObject({ outcome: "CONFIRMED" });

    const settlement = await env.DB.prepare(
      "SELECT state, state_version FROM settlements WHERE id = ?",
    )
      .bind(setup.settlementId)
      .first<{ state: string; state_version: number }>();
    expect(settlement).toEqual({ state: "CONFIRMED", state_version: 2 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM settlement_attempts
         WHERE settlement_distribution_id IN (
           SELECT id FROM settlement_distributions WHERE settlement_id = ?
         ) AND status = 'CONFIRMED'`,
      )
        .bind(setup.settlementId)
        .first<number>("count"),
    ).toBe(3);
    const attempts = await env.DB.prepare(
      `SELECT sa.id, sa.idempotency_key
       FROM settlement_attempts sa
       JOIN settlement_distributions sd
         ON sd.id = sa.settlement_distribution_id
       WHERE sd.settlement_id = ?`,
    )
      .bind(setup.settlementId)
      .all<{ id: string; idempotency_key: string }>();
    expect(
      attempts.results.every(
        ({ id, idempotency_key }) =>
          id === idempotency_key &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            idempotency_key,
          ),
      ),
    ).toBe(true);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM settlement_provider_transactions spt
         JOIN settlement_attempts sa ON sa.id = spt.settlement_attempt_id
         JOIN settlement_distributions sd ON sd.id = sa.settlement_distribution_id
         WHERE sd.settlement_id = ?`,
      )
        .bind(setup.settlementId)
        .first<number>("count"),
    ).toBe(3);
    await expect(
      executeSettlementWorkItem(
        env.DB,
        setup.workItemId,
        "simulation",
        setup.provider,
      ),
    ).resolves.toMatchObject({ outcome: "ALREADY_COMPLETED" });
  });

  it("records accepted pending transfers without treating them as confirmed", async () => {
    const setup = await prepareProviderExecution("provider-pending", "PENDING");
    const result = await executeSettlementWorkItem(
      env.DB,
      setup.workItemId,
      "simulation",
      setup.provider,
    );
    expect(result.outcome).toBe("SUBMITTED");
    expect(
      await env.DB.prepare("SELECT state FROM settlements WHERE id = ?")
        .bind(setup.settlementId)
        .first<string>("state"),
    ).toBe("SUBMITTED");
  });

  it("schedules an explicit retry only after a provider-declared retryable failure", async () => {
    const setup = await prepareProviderExecution(
      "provider-retryable",
      "RETRYABLE_FAILURE",
    );
    const result = await executeSettlementWorkItem(
      env.DB,
      setup.workItemId,
      "simulation",
      setup.provider,
    );
    expect(result.outcome).toBe("RETRY_SCHEDULED");
    const work = await env.DB.prepare(
      `SELECT status, next_attempt_at, attempt_count
       FROM settlement_work_items WHERE id = ?`,
    )
      .bind(setup.workItemId)
      .first<{
        status: string;
        next_attempt_at: string | null;
        attempt_count: number;
      }>();
    expect(work).toMatchObject({ status: "PENDING", attempt_count: 1 });
    expect(work?.next_attempt_at).not.toBeNull();
  });

  it("fails visibly on a terminal provider rejection", async () => {
    const setup = await prepareProviderExecution(
      "provider-terminal",
      "TERMINAL_FAILURE",
    );
    await expect(
      executeSettlementWorkItem(
        env.DB,
        setup.workItemId,
        "simulation",
        setup.provider,
      ),
    ).resolves.toMatchObject({ outcome: "TERMINAL_FAILURE" });
    expect(
      await env.DB.prepare("SELECT state FROM settlements WHERE id = ?")
        .bind(setup.settlementId)
        .first<string>("state"),
    ).toBe("FAILED");
  });

  it("freezes an ambiguous accepted outcome instead of resubmitting", async () => {
    const setup = await prepareProviderExecution(
      "provider-unknown",
      "UNKNOWN_AFTER_ACCEPT",
    );
    const first = await executeSettlementWorkItem(
      env.DB,
      setup.workItemId,
      "simulation",
      setup.provider,
    );
    expect(first.outcome).toBe("OUTCOME_UNKNOWN");
    await expect(
      executeSettlementWorkItem(
        env.DB,
        setup.workItemId,
        "simulation",
        setup.provider,
      ),
    ).rejects.toBeInstanceOf(SettlementExecutionUnavailableError);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM settlement_attempts
         WHERE settlement_distribution_id IN (
           SELECT id FROM settlement_distributions WHERE settlement_id = ?
         )`,
      )
        .bind(setup.settlementId)
        .first<number>("count"),
    ).toBe(1);
  });
});

describe("processDueSettlementWork", () => {
  it("recovers due durable work without requiring another queue delivery", async () => {
    const setup = await prepareProviderExecution(
      "scheduled-provider-work",
      "CONFIRMED",
    );
    await expect(
      processDueSettlementWork(env.DB, "simulation", setup.provider, {
        now: "2026-09-14T12:05:00Z",
        organisationId: setup.organisationId,
      }),
    ).resolves.toEqual({
      selected: 1,
      completed: 1,
      deferred: 0,
      failed: 0,
    });
    await expect(
      processDueSettlementWork(env.DB, "simulation", setup.provider, {
        now: "2026-09-14T12:10:00Z",
        organisationId: setup.organisationId,
      }),
    ).resolves.toEqual({
      selected: 0,
      completed: 0,
      deferred: 0,
      failed: 0,
    });
  });
});

describe("observeProviderTransaction", () => {
  it("confirms the parent only after every pending transfer confirms", async () => {
    const setup = await prepareProviderExecution(
      "provider-delayed-confirmation",
      "PENDING",
    );
    await executeSettlementWorkItem(
      env.DB,
      setup.workItemId,
      "simulation",
      setup.provider,
    );
    const transactions = await env.DB.prepare(
      `SELECT spt.id, spt.provider_transaction_id
       FROM settlement_provider_transactions spt
       JOIN settlement_attempts sa ON sa.id = spt.settlement_attempt_id
       JOIN settlement_distributions sd ON sd.id = sa.settlement_distribution_id
       WHERE sd.settlement_id = ? ORDER BY sd.position`,
    )
      .bind(setup.settlementId)
      .all<{ id: string; provider_transaction_id: string }>();
    expect(transactions.results).toHaveLength(3);

    for (const [index, transaction] of transactions.results.entries()) {
      setup.provider.setTransactionState(
        transaction.provider_transaction_id,
        "CONFIRMED",
      );
      const observation = await observeProviderTransaction(
        env.DB,
        transaction.id,
        "simulation",
        setup.provider,
      );
      expect(observation.outcome).toBe("CONFIRMED");
      expect(observation.settlementState).toBe(
        index === transactions.results.length - 1 ? "CONFIRMED" : "SUBMITTED",
      );
    }
    expect(
      await env.DB.prepare("SELECT state FROM settlements WHERE id = ?")
        .bind(setup.settlementId)
        .first<string>("state"),
    ).toBe("CONFIRMED");
  });

  it("moves a submitted settlement to failed when the provider later fails", async () => {
    const setup = await prepareProviderExecution(
      "provider-late-failure",
      "PENDING",
    );
    await executeSettlementWorkItem(
      env.DB,
      setup.workItemId,
      "simulation",
      setup.provider,
    );
    const transaction = await env.DB.prepare(
      `SELECT spt.id, spt.provider_transaction_id
       FROM settlement_provider_transactions spt
       JOIN settlement_attempts sa ON sa.id = spt.settlement_attempt_id
       JOIN settlement_distributions sd ON sd.id = sa.settlement_distribution_id
       WHERE sd.settlement_id = ? ORDER BY sd.position LIMIT 1`,
    )
      .bind(setup.settlementId)
      .first<{ id: string; provider_transaction_id: string }>();
    if (!transaction) throw new Error("Expected a provider transaction.");
    setup.provider.setTransactionState(
      transaction.provider_transaction_id,
      "FAILED",
      "SIM_LATE_FAILURE",
    );

    const observation = await observeProviderTransaction(
      env.DB,
      transaction.id,
      "simulation",
      setup.provider,
    );
    expect(observation).toMatchObject({
      outcome: "FAILED",
      settlementState: "FAILED",
    });
    expect(
      await env.DB.prepare("SELECT state FROM settlements WHERE id = ?")
        .bind(setup.settlementId)
        .first<string>("state"),
    ).toBe("FAILED");
  });

  it("unfreezes remaining work only after an ambiguous transfer is confirmed", async () => {
    const setup = await prepareProviderExecution(
      "provider-unknown-recovered",
      "UNKNOWN_AFTER_ACCEPT",
    );
    await executeSettlementWorkItem(
      env.DB,
      setup.workItemId,
      "simulation",
      setup.provider,
    );
    const transaction = await env.DB.prepare(
      `SELECT spt.id, spt.provider_transaction_id
       FROM settlement_provider_transactions spt
       JOIN settlement_attempts sa ON sa.id = spt.settlement_attempt_id
       JOIN settlement_distributions sd ON sd.id = sa.settlement_distribution_id
       WHERE sd.settlement_id = ? LIMIT 1`,
    )
      .bind(setup.settlementId)
      .first<{ id: string; provider_transaction_id: string }>();
    if (!transaction) throw new Error("Expected an ambiguous transaction.");

    await expect(
      observeProviderTransaction(
        env.DB,
        transaction.id,
        "simulation",
        setup.provider,
      ),
    ).resolves.toMatchObject({ outcome: "PENDING" });
    expect(
      await env.DB.prepare(
        "SELECT status FROM settlement_work_items WHERE id = ?",
      )
        .bind(setup.workItemId)
        .first<string>("status"),
    ).toBe("FAILED");

    setup.provider.setTransactionState(
      transaction.provider_transaction_id,
      "CONFIRMED",
    );
    await expect(
      observeProviderTransaction(
        env.DB,
        transaction.id,
        "simulation",
        setup.provider,
      ),
    ).resolves.toMatchObject({
      outcome: "CONFIRMED",
      settlementState: "SUBMITTING",
    });
    expect(
      await env.DB.prepare(
        "SELECT status FROM settlement_work_items WHERE id = ?",
      )
        .bind(setup.workItemId)
        .first<string>("status"),
    ).toBe("PENDING");
  });
});

describe("processDueProviderObservations", () => {
  it("leases and confirms due provider transactions without another queue delivery", async () => {
    const setup = await prepareProviderExecution(
      "scheduled-provider-observation",
      "PENDING",
    );
    await executeSettlementWorkItem(
      env.DB,
      setup.workItemId,
      "simulation",
      setup.provider,
    );
    const transactions = await env.DB.prepare(
      `SELECT spt.provider_transaction_id
       FROM settlement_provider_transactions spt
       JOIN settlement_attempts sa ON sa.id = spt.settlement_attempt_id
       JOIN settlement_distributions sd ON sd.id = sa.settlement_distribution_id
       WHERE sd.settlement_id = ?`,
    )
      .bind(setup.settlementId)
      .all<{ provider_transaction_id: string }>();
    for (const transaction of transactions.results) {
      setup.provider.setTransactionState(
        transaction.provider_transaction_id,
        "CONFIRMED",
      );
    }
    await expect(
      processDueProviderObservations(env.DB, "simulation", setup.provider, {
        now: "2026-09-14T12:10:00Z",
        organisationId: setup.organisationId,
      }),
    ).resolves.toEqual({
      selected: 3,
      confirmed: 3,
      pending: 0,
      failed: 0,
      notFound: 0,
      errored: 0,
    });
    expect(
      await env.DB.prepare("SELECT state FROM settlements WHERE id = ?")
        .bind(setup.settlementId)
        .first<string>("state"),
    ).toBe("CONFIRMED");
  });

  it("defers unchanged pending observations with exponential polling backoff", async () => {
    const setup = await prepareProviderExecution(
      "scheduled-provider-backoff",
      "PENDING",
    );
    await executeSettlementWorkItem(
      env.DB,
      setup.workItemId,
      "simulation",
      setup.provider,
    );
    const first = await processDueProviderObservations(
      env.DB,
      "simulation",
      setup.provider,
      {
        now: "2026-09-14T12:10:00Z",
        organisationId: setup.organisationId,
      },
    );
    expect(first).toMatchObject({ selected: 3, pending: 3 });
    await expect(
      processDueProviderObservations(env.DB, "simulation", setup.provider, {
        now: "2026-09-14T12:10:10Z",
        organisationId: setup.organisationId,
      }),
    ).resolves.toMatchObject({ selected: 0 });
  });
});

describe("recordSettlementRecovery", () => {
  it("requires explicit provider non-submission evidence before retrying an unknown call", async () => {
    const setup = await prepareProviderExecution(
      "operator-recovery",
      "CONFIRMED",
    );
    const throwingProvider: SettlementProvider = {
      validateDestination: (destination) =>
        Promise.resolve({ valid: true, normalized: destination }),
      submitTransfer: () => Promise.reject(new Error("Connection interrupted")),
      getTransaction: () => Promise.resolve({ outcome: "NOT_FOUND" }),
    };
    await expect(
      executeSettlementWorkItem(
        env.DB,
        setup.workItemId,
        "simulation",
        throwingProvider,
      ),
    ).resolves.toMatchObject({ outcome: "OUTCOME_UNKNOWN" });
    const attemptId = await env.DB.prepare(
      `SELECT sa.id FROM settlement_attempts sa
       JOIN settlement_distributions sd ON sd.id = sa.settlement_distribution_id
       WHERE sd.settlement_id = ? AND sa.status = 'OUTCOME_UNKNOWN'`,
    )
      .bind(setup.settlementId)
      .first<string>("id");
    if (!attemptId) throw new Error("Expected an unknown settlement attempt.");
    const command = {
      decisionId: "recovery-decision-operator",
      organisationId: setup.organisationId,
      settlementId: setup.settlementId,
      attemptId,
      actorId: "finance-operator",
      action: "RETRY_CONFIRMED_NOT_SUBMITTED",
      reason: "Provider support confirmed that no transfer was created.",
      evidenceReference: "support-case:ARC-2026-0914",
      decidedAt: "2026-09-14T12:20:00Z",
    } as const;
    await expect(recordSettlementRecovery(env.DB, command)).resolves.toEqual({
      decisionId: command.decisionId,
      settlementId: setup.settlementId,
      attemptId,
      outcome: "RETRY_SCHEDULED",
      replayed: false,
    });
    await expect(
      recordSettlementRecovery(env.DB, command),
    ).resolves.toMatchObject({
      replayed: true,
    });
    await expect(
      recordSettlementRecovery(env.DB, {
        ...command,
        reason: "Changed recovery assertion.",
      }),
    ).rejects.toBeInstanceOf(SettlementRecoveryConflictError);
    expect(
      await env.DB.prepare(
        "SELECT status FROM settlement_work_items WHERE id = ?",
      )
        .bind(setup.workItemId)
        .first<string>("status"),
    ).toBe("PENDING");
    await expect(
      executeSettlementWorkItem(
        env.DB,
        setup.workItemId,
        "simulation",
        setup.provider,
      ),
    ).resolves.toMatchObject({ outcome: "CONFIRMED" });
    await expect(
      env.DB.prepare("DELETE FROM settlement_recovery_decisions WHERE id = ?")
        .bind(command.decisionId)
        .run(),
    ).rejects.toThrow(/append-only/);
  });
});

async function seedLedgerAccounts(
  organisationId: string,
  suffix: string,
): Promise<{ cash: string; clearing: string }> {
  const cash = `digital-cash-${suffix}`;
  const clearing = `settlement-clearing-${suffix}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ledger_accounts (
        id, organisation_id, code, name, account_type, asset_code,
        asset_scale, status, created_at
      ) VALUES (?, ?, ?, 'Digital Cash', 'ASSET', 'USD', 2, 'ACTIVE', ?)`,
    ).bind(cash, organisationId, `1000-${suffix}`, now),
    env.DB.prepare(
      `INSERT INTO ledger_accounts (
        id, organisation_id, code, name, account_type, asset_code,
        asset_scale, status, created_at
      ) VALUES (?, ?, ?, 'Settlement Clearing', 'LIABILITY', 'USD', 2, 'ACTIVE', ?)`,
    ).bind(clearing, organisationId, `2000-${suffix}`, now),
  ]);
  return { cash, clearing };
}

describe("postJournal", () => {
  it("posts one exact balanced journal and returns it for concurrent replays", async () => {
    const setup = await prepareProviderExecution(
      "journal-posting",
      "CONFIRMED",
    );
    await executeSettlementWorkItem(
      env.DB,
      setup.workItemId,
      "simulation",
      setup.provider,
    );
    const accounts = await seedLedgerAccounts(
      setup.organisationId,
      "journal-posting",
    );
    const posting = {
      postingId: "journal-settlement-journal-posting",
      organisationId: setup.organisationId,
      sourceType: "SETTLEMENT",
      sourceId: setup.settlementId,
      postingPurpose: "SETTLEMENT_CASH_MOVEMENT",
      postingPolicyVersion: "demo-policy-v1",
      effectiveAt: now,
      correlationId: "correlation-journal-posting",
      actorId: "accounting-poster",
      lines: [
        {
          accountId: accounts.clearing,
          direction: "DEBIT",
          amount: { assetCode: "USD", atomicAmount: "100000", scale: 2 },
        },
        {
          accountId: accounts.cash,
          direction: "CREDIT",
          amount: { assetCode: "USD", atomicAmount: "100000", scale: 2 },
        },
      ],
    } as const;

    const results = await Promise.all([
      postJournal(env.DB, posting),
      postJournal(env.DB, posting),
    ]);
    expect(results.map(({ replayed }) => replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM journal_lines WHERE journal_entry_id = ?",
      )
        .bind(posting.postingId)
        .first<number>("count"),
    ).toBe(2);
    expect(
      await env.DB.prepare("SELECT status FROM journal_entries WHERE id = ?")
        .bind(posting.postingId)
        .first<string>("status"),
    ).toBe("POSTED");
  });

  it("rejects changed financial data and mutation of posted history", async () => {
    const setup = await prepareProviderExecution(
      "journal-immutable",
      "CONFIRMED",
    );
    const accounts = await seedLedgerAccounts(
      setup.organisationId,
      "journal-immutable",
    );
    const posting = {
      postingId: "journal-immutable",
      organisationId: setup.organisationId,
      sourceType: "SETTLEMENT",
      sourceId: setup.settlementId,
      postingPurpose: "SETTLEMENT_CASH_MOVEMENT",
      postingPolicyVersion: "demo-policy-v1",
      effectiveAt: now,
      correlationId: "correlation-journal-immutable",
      actorId: "accounting-poster",
      lines: [
        {
          accountId: accounts.clearing,
          direction: "DEBIT",
          amount: { assetCode: "USD", atomicAmount: "100000", scale: 2 },
        },
        {
          accountId: accounts.cash,
          direction: "CREDIT",
          amount: { assetCode: "USD", atomicAmount: "100000", scale: 2 },
        },
      ],
    } as const;
    await postJournal(env.DB, posting);
    await expect(
      postJournal(env.DB, {
        ...posting,
        postingPolicyVersion: "changed-policy-v2",
      }),
    ).rejects.toBeInstanceOf(JournalPostingConflictError);
    await expect(
      env.DB.prepare(
        "UPDATE journal_lines SET amount_atomic = '1' WHERE journal_entry_id = ?",
      )
        .bind(posting.postingId)
        .run(),
    ).rejects.toThrow(/journal lines are immutable/);
    await expect(
      env.DB.prepare("DELETE FROM journal_entries WHERE id = ?")
        .bind(posting.postingId)
        .run(),
    ).rejects.toThrow(/cannot be deleted/);
  });
});

async function prepareReconciliation(suffix: string): Promise<{
  organisationId: string;
  settlementId: string;
  distributionIds: readonly string[];
  providerTransactionIds: readonly string[];
  journalEntryId: string;
}> {
  const setup = await prepareProviderExecution(suffix, "CONFIRMED");
  await executeSettlementWorkItem(
    env.DB,
    setup.workItemId,
    "simulation",
    setup.provider,
  );
  const accounts = await seedLedgerAccounts(setup.organisationId, suffix);
  const distributions = await env.DB.prepare(
    `SELECT sd.id, sd.amount_atomic, spt.id AS provider_transaction_record_id
     FROM settlement_distributions sd
     JOIN settlement_attempts sa ON sa.settlement_distribution_id = sd.id
     JOIN settlement_provider_transactions spt ON spt.settlement_attempt_id = sa.id
     WHERE sd.settlement_id = ? ORDER BY sd.position`,
  )
    .bind(setup.settlementId)
    .all<{
      id: string;
      amount_atomic: string;
      provider_transaction_record_id: string;
    }>();
  const journalEntryId = `journal-reconciliation-${suffix}`;
  await postJournal(env.DB, {
    postingId: journalEntryId,
    organisationId: setup.organisationId,
    sourceType: "SETTLEMENT",
    sourceId: setup.settlementId,
    postingPurpose: "SETTLEMENT_CASH_MOVEMENT",
    postingPolicyVersion: "demo-policy-v1",
    effectiveAt: now,
    correlationId: `correlation-${suffix}`,
    actorId: "accounting-poster",
    lines: [
      ...distributions.results.map((distribution) => ({
        accountId: accounts.clearing,
        direction: "DEBIT" as const,
        amount: {
          assetCode: "USD",
          atomicAmount: distribution.amount_atomic,
          scale: 2,
        },
        memo: `Distribution ${distribution.id}`,
      })),
      {
        accountId: accounts.cash,
        direction: "CREDIT",
        amount: { assetCode: "USD", atomicAmount: "100000", scale: 2 },
      },
    ],
  });
  return {
    organisationId: setup.organisationId,
    settlementId: setup.settlementId,
    distributionIds: distributions.results.map(({ id }) => id),
    providerTransactionIds: distributions.results.map(
      ({ provider_transaction_record_id }) => provider_transaction_record_id,
    ),
    journalEntryId,
  };
}

describe("reconcileDistribution", () => {
  it("matches provider, entitlement, and exact posted journal evidence once", async () => {
    const setup = await prepareReconciliation("reconciliation-match");
    const command = {
      reconciliationId: "reconciliation-match",
      organisationId: setup.organisationId,
      distributionId: setup.distributionIds[0] ?? "missing",
      providerTransactionRecordId: setup.providerTransactionIds[0] ?? "missing",
      journalEntryId: setup.journalEntryId,
      journalLineId: `${setup.journalEntryId}:0`,
      correlationId: "correlation-reconciliation-match",
      actorId: "reconciliation-service",
    } as const;
    const result = await reconcileDistribution(env.DB, command);
    expect(result).toMatchObject({ status: "MATCHED", replayed: false });
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
    await expect(reconcileDistribution(env.DB, command)).resolves.toEqual({
      ...result,
      replayed: true,
    });
  });

  it("records a visible mismatch and rejects changed reconciliation inputs", async () => {
    const setup = await prepareReconciliation("reconciliation-mismatch");
    const command = {
      reconciliationId: "reconciliation-mismatch",
      organisationId: setup.organisationId,
      distributionId: setup.distributionIds[0] ?? "missing",
      providerTransactionRecordId: setup.providerTransactionIds[0] ?? "missing",
      journalEntryId: setup.journalEntryId,
      journalLineId: `${setup.journalEntryId}:1`,
      correlationId: "correlation-reconciliation-mismatch",
      actorId: "reconciliation-service",
    } as const;
    const result = await reconcileDistribution(env.DB, command);
    expect(result.status).toBe("MISMATCHED");
    expect(result.checks.amountMatches).toBe(false);
    await expect(
      reconcileDistribution(env.DB, {
        ...command,
        journalLineId: `${setup.journalEntryId}:0`,
      }),
    ).rejects.toBeInstanceOf(ReconciliationConflictError);
  });
});

describe("processAccountingWorkItem", () => {
  it("automatically posts and reconciles a confirmed settlement exactly once", async () => {
    const suffix = "accounting-orchestration";
    const setup = await prepareProviderExecution(suffix, "CONFIRMED");
    await executeSettlementWorkItem(
      env.DB,
      setup.workItemId,
      "simulation",
      setup.provider,
    );
    const accounts = await seedLedgerAccounts(setup.organisationId, suffix);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO accounting_posting_policies (
          id, organisation_id, name, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
      ).bind(
        `accounting-policy-${suffix}`,
        setup.organisationId,
        "Settlement cash movement",
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO accounting_posting_policy_versions (
          id, policy_id, version, trigger_event_type, priority,
          effective_from, policy_json, created_by, created_at
        ) VALUES (?, ?, 1, 'FLOWPAY_SETTLEMENT_CONFIRMED', 100, ?, ?, 'seed', ?)`,
      ).bind(
        `accounting-policy-version-${suffix}`,
        `accounting-policy-${suffix}`,
        "2026-09-01T00:00:00Z",
        JSON.stringify({
          kind: "SETTLEMENT_CASH_MOVEMENT_V1",
          assetCode: "USD",
          scale: 2,
          distributionDebitAccountId: accounts.clearing,
          cashCreditAccountId: accounts.cash,
        }),
        now,
      ),
    ]);
    const confirmedMessage = await env.DB.prepare(
      `SELECT id AS messageId, organisation_id AS organisationId,
              message_type AS messageType, schema_version AS schemaVersion,
              aggregate_type AS aggregateType, aggregate_id AS aggregateId,
              correlation_id AS correlationId, causation_id AS causationId,
              payload_json AS payloadJson, created_at AS createdAt
       FROM outbox_messages
       WHERE organisation_id = ?
         AND message_type = 'FLOWPAY_SETTLEMENT_CONFIRMED'`,
    )
      .bind(setup.organisationId)
      .first<FlowPayQueueMessage>();
    if (!confirmedMessage) throw new Error("Expected a confirmation message.");
    await consumeFlowPayMessage(env.DB, confirmedMessage);

    const first = await processAccountingWorkItem(
      env.DB,
      confirmedMessage.messageId,
    );
    expect(first).toMatchObject({
      outcome: "COMPLETED",
      reconciliationCount: 3,
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM journal_lines WHERE journal_entry_id = ?",
      )
        .bind(first.journalEntryId)
        .first<number>("count"),
    ).toBe(4);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM reconciliation_records rr
         JOIN settlement_distributions sd
           ON sd.id = rr.settlement_distribution_id
         WHERE sd.settlement_id = ? AND rr.status = 'MATCHED'`,
      )
        .bind(setup.settlementId)
        .first<number>("count"),
    ).toBe(3);
    await expect(
      processAccountingWorkItem(env.DB, confirmedMessage.messageId),
    ).resolves.toEqual({ ...first, outcome: "ALREADY_COMPLETED" });
  });
});

async function seedBusinessPayment(
  suffix: string,
  jobStatus: "IN_PROGRESS" | "COMPLETED" = "COMPLETED",
): Promise<{
  organisationId: string;
  paymentId: string;
}> {
  const seeded = await seedConfiguration({ suffix });
  const customerId = `customer-${suffix}`;
  const jobId = `job-${suffix}`;
  const invoiceId = `invoice-${suffix}`;
  const paymentId = `payment-business-${suffix}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO customers (
        id, organisation_id, display_name, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
    ).bind(customerId, seeded.organisationId, `Customer ${suffix}`, now, now),
    env.DB.prepare(
      `INSERT INTO jobs (
        id, organisation_id, customer_id, reference, title, status,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      jobId,
      seeded.organisationId,
      customerId,
      `JOB-${suffix}`,
      `Job ${suffix}`,
      jobStatus,
      now,
      now,
      jobStatus === "COMPLETED" ? now : null,
    ),
    env.DB.prepare(
      `INSERT INTO invoices (
        id, organisation_id, customer_id, job_id, reference, status,
        asset_code, total_atomic, asset_scale, issued_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'ISSUED', 'USD', '100000', 2, ?, ?, ?)`,
    ).bind(
      invoiceId,
      seeded.organisationId,
      customerId,
      jobId,
      `INV-${suffix}`,
      now,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO payments (
        id, organisation_id, invoice_id, external_reference, status,
        asset_code, amount_atomic, asset_scale, received_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'PENDING', 'USD', '100000', 2, ?, ?, ?)`,
    ).bind(
      paymentId,
      seeded.organisationId,
      invoiceId,
      `external-${suffix}`,
      now,
      now,
      now,
    ),
  ]);
  return { organisationId: seeded.organisationId, paymentId };
}

function paymentConfirmationCommand(
  organisationId: string,
  paymentId: string,
  suffix: string,
) {
  return {
    commandId: `confirm-payment-${suffix}`,
    organisationId,
    paymentId,
    actorId: "payments-operator",
    correlationId: `correlation-business-${suffix}`,
    confirmedAt: now,
  } as const;
}

describe("business payment event adapter", () => {
  it("atomically confirms payment and creates the generic FlowPay settlement", async () => {
    const seeded = await seedBusinessPayment("business-flow");
    const command = paymentConfirmationCommand(
      seeded.organisationId,
      seeded.paymentId,
      "business-flow",
    );
    const confirmations = await Promise.all([
      confirmPayment(env.DB, command),
      confirmPayment(env.DB, command),
    ]);
    expect(confirmations.map(({ replayed }) => replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(confirmations[0]?.invoiceStatus).toBe("PAID");
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM invoice_state_transitions
         WHERE invoice_id = (SELECT invoice_id FROM payments WHERE id = ?)
           AND to_status = 'PAID'`,
      )
        .bind(seeded.paymentId)
        .first<number>("count"),
    ).toBe(1);

    const message = await env.DB.prepare(
      `SELECT id AS messageId, organisation_id AS organisationId,
              message_type AS messageType, schema_version AS schemaVersion,
              aggregate_type AS aggregateType, aggregate_id AS aggregateId,
              correlation_id AS correlationId, causation_id AS causationId,
              payload_json AS payloadJson, created_at AS createdAt
       FROM outbox_messages
       WHERE organisation_id = ? AND message_type = 'BUSINESS_PAYMENT_CONFIRMED'`,
    )
      .bind(seeded.organisationId)
      .first<FlowPayQueueMessage>();
    if (!message) throw new Error("Expected a payment-confirmed message.");
    await consumeFlowPayMessage(env.DB, message);
    const settlement = await processPaymentConfirmedMessage(env.DB, message);
    expect(settlement).toMatchObject({
      outcome: "MATCHED",
      settlement: { state: "PENDING_APPROVAL" },
    });
    await expect(
      processPaymentConfirmedMessage(env.DB, message),
    ).resolves.toMatchObject({ replayed: true });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM settlements WHERE organisation_id = ?",
      )
        .bind(seeded.organisationId)
        .first<number>("count"),
    ).toBe(1);
  });

  it("records a no-match evaluation when the operational condition is not met", async () => {
    const seeded = await seedBusinessPayment(
      "business-incomplete-job",
      "IN_PROGRESS",
    );
    await confirmPayment(
      env.DB,
      paymentConfirmationCommand(
        seeded.organisationId,
        seeded.paymentId,
        "business-incomplete-job",
      ),
    );
    const message = await env.DB.prepare(
      `SELECT id AS messageId, organisation_id AS organisationId,
              message_type AS messageType, schema_version AS schemaVersion,
              aggregate_type AS aggregateType, aggregate_id AS aggregateId,
              correlation_id AS correlationId, causation_id AS causationId,
              payload_json AS payloadJson, created_at AS createdAt
       FROM outbox_messages
       WHERE organisation_id = ? AND message_type = 'BUSINESS_PAYMENT_CONFIRMED'`,
    )
      .bind(seeded.organisationId)
      .first<FlowPayQueueMessage>();
    if (!message) throw new Error("Expected a payment-confirmed message.");
    await expect(
      processPaymentConfirmedMessage(env.DB, message),
    ).resolves.toMatchObject({ outcome: "NO_MATCH" });
  });

  it("rejects changed retries and unaudited direct payment status mutation", async () => {
    const seeded = await seedBusinessPayment("business-controls");
    const command = paymentConfirmationCommand(
      seeded.organisationId,
      seeded.paymentId,
      "business-controls",
    );
    await confirmPayment(env.DB, command);
    await expect(
      confirmPayment(env.DB, { ...command, actorId: "different-operator" }),
    ).rejects.toBeInstanceOf(PaymentConfirmationConflictError);

    const other = await seedBusinessPayment("business-direct-mutation");
    await expect(
      env.DB.prepare("UPDATE payments SET status = 'CONFIRMED' WHERE id = ?")
        .bind(other.paymentId)
        .run(),
    ).rejects.toThrow(/payment status transition must be recorded/);
  });
});

async function loadOutboxMessage(
  organisationId: string,
  messageType: string,
): Promise<FlowPayQueueMessage> {
  const message = await env.DB.prepare(
    `SELECT id AS messageId, organisation_id AS organisationId,
            message_type AS messageType, schema_version AS schemaVersion,
            aggregate_type AS aggregateType, aggregate_id AS aggregateId,
            correlation_id AS correlationId, causation_id AS causationId,
            payload_json AS payloadJson, created_at AS createdAt
     FROM outbox_messages
     WHERE organisation_id = ? AND message_type = ?
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  )
    .bind(organisationId, messageType)
    .first<FlowPayQueueMessage>();
  if (!message) throw new Error(`Expected ${messageType} outbox message.`);
  return message;
}

describe("FlowPay flagship acceptance journey", () => {
  it("carries a verified business payment through approval, settlement, accounting, reconciliation and audit", async () => {
    const suffix = "acceptance-journey";
    const seeded = await seedBusinessPayment(suffix);
    const confirmation = paymentConfirmationCommand(
      seeded.organisationId,
      seeded.paymentId,
      suffix,
    );

    await confirmPayment(env.DB, confirmation);
    const paymentMessage = await loadOutboxMessage(
      seeded.organisationId,
      "BUSINESS_PAYMENT_CONFIRMED",
    );
    await consumeFlowPayMessage(env.DB, paymentMessage);
    const evaluated = await processPaymentConfirmedMessage(
      env.DB,
      paymentMessage,
    );
    if (!evaluated.settlement) throw new Error("Expected a settlement.");
    expect(evaluated.settlement.state).toBe("PENDING_APPROVAL");

    await expect(
      recordApprovalDecision(env.DB, {
        decisionId: `approval-${suffix}`,
        organisationId: seeded.organisationId,
        settlementId: evaluated.settlement.id,
        actorId: "finance-manager",
        actorRoles: ["MANAGER"],
        decision: "APPROVE",
        reason: "Verified completed work and confirmed customer funds.",
      }),
    ).resolves.toMatchObject({
      approvalOutcome: "APPROVED",
      settlement: { state: "READY" },
    });

    const readyMessage = await loadOutboxMessage(
      seeded.organisationId,
      "FLOWPAY_SETTLEMENT_READY",
    );
    await consumeFlowPayMessage(env.DB, readyMessage);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO settlement_provider_sources (
          id, organisation_id, provider, network, source_reference,
          status, created_at, updated_at
        ) VALUES (?, ?, 'simulation', 'simnet', ?, 'ACTIVE', ?, ?)`,
      ).bind(
        `source-${suffix}`,
        seeded.organisationId,
        `treasury-${suffix}`,
        now,
        now,
      ),
      ...["workshop", "mechanic", "referrer"].map((participant) =>
        env.DB.prepare(
          `INSERT INTO participant_settlement_destinations (
            id, organisation_id, participant_id, provider, network, address,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, 'simulation', 'simnet', ?, 'ACTIVE', ?, ?)`,
        ).bind(
          `destination-${participant}-${suffix}`,
          seeded.organisationId,
          `${participant}-${suffix}`,
          `sim:${participant}-${suffix}`,
          now,
          now,
        ),
      ),
    ]);
    const accounts = await seedLedgerAccounts(seeded.organisationId, suffix);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO accounting_posting_policies (
          id, organisation_id, name, status, created_at, updated_at
        ) VALUES (?, ?, 'Settlement cash movement', 'ACTIVE', ?, ?)`,
      ).bind(`accounting-policy-${suffix}`, seeded.organisationId, now, now),
      env.DB.prepare(
        `INSERT INTO accounting_posting_policy_versions (
          id, policy_id, version, trigger_event_type, priority,
          effective_from, policy_json, created_by, created_at
        ) VALUES (?, ?, 1, 'FLOWPAY_SETTLEMENT_CONFIRMED', 100, ?, ?, 'seed', ?)`,
      ).bind(
        `accounting-policy-version-${suffix}`,
        `accounting-policy-${suffix}`,
        "2026-09-01T00:00:00Z",
        JSON.stringify({
          kind: "SETTLEMENT_CASH_MOVEMENT_V1",
          assetCode: "USD",
          scale: 2,
          distributionDebitAccountId: accounts.clearing,
          cashCreditAccountId: accounts.cash,
        }),
        now,
      ),
    ]);

    const provider = new SimulationSettlementProvider("CONFIRMED");
    await expect(
      executeSettlementWorkItem(
        env.DB,
        readyMessage.messageId,
        "simulation",
        provider,
      ),
    ).resolves.toMatchObject({ outcome: "CONFIRMED" });
    await expect(
      executeSettlementWorkItem(
        env.DB,
        readyMessage.messageId,
        "simulation",
        provider,
      ),
    ).resolves.toMatchObject({ outcome: "ALREADY_COMPLETED" });

    const confirmedMessage = await loadOutboxMessage(
      seeded.organisationId,
      "FLOWPAY_SETTLEMENT_CONFIRMED",
    );
    await consumeFlowPayMessage(env.DB, confirmedMessage);
    const accounting = await processAccountingWorkItem(
      env.DB,
      confirmedMessage.messageId,
    );
    expect(accounting).toMatchObject({
      outcome: "COMPLETED",
      reconciliationCount: 3,
    });

    const distributions = await env.DB.prepare(
      `SELECT amount_atomic, state FROM settlement_distributions
       WHERE settlement_id = ? ORDER BY position`,
    )
      .bind(evaluated.settlement.id)
      .all<{ amount_atomic: string; state: string }>();
    expect(distributions.results).toEqual([
      { amount_atomic: "25000", state: "CONFIRMED" },
      { amount_atomic: "70000", state: "CONFIRMED" },
      { amount_atomic: "5000", state: "CONFIRMED" },
    ]);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM reconciliation_records rr
         JOIN settlement_distributions sd
           ON sd.id = rr.settlement_distribution_id
         WHERE sd.settlement_id = ? AND rr.status = 'MATCHED'`,
      )
        .bind(evaluated.settlement.id)
        .first<number>("count"),
    ).toBe(3);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(DISTINCT action) AS count FROM audit_events
         WHERE organisation_id = ? AND correlation_id = ?
           AND action IN (
             'PAYMENT_CONFIRMED', 'SETTLEMENT_RULE_EVALUATED',
             'APPROVAL_DECISION_RECORDED', 'SETTLEMENT_CONFIRMED',
             'JOURNAL_POSTED', 'DISTRIBUTION_RECONCILED'
           )`,
      )
        .bind(seeded.organisationId, confirmation.correlationId)
        .first<number>("count"),
    ).toBe(6);
  });
});
