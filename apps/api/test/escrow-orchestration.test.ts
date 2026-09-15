import { env } from "cloudflare:workers";
import { SimulationSettlementProvider } from "@flowpay/provider-simulation";
import { describe, expect, it } from "vitest";

import {
  issueInvoice,
  recordPendingPayment,
} from "../src/business/author-financial-document.ts";
import { confirmPayment } from "../src/business/confirm-payment.ts";
import {
  createApprovalPolicy,
  createSettlementRule,
  transitionConfiguration,
} from "../src/flowpay/author-configuration.ts";
import { executeSettlementWorkItem } from "../src/flowpay/execute-settlement-work-item.ts";
import {
  createEscrow,
  transitionEscrowArrangement,
} from "../src/flowpay/manage-escrow.ts";
import { processEscrowSettlementConfirmed } from "../src/flowpay/process-escrow-release.ts";
import { verifyEscrowMilestone } from "../src/flowpay/verify-escrow-milestone.ts";
import { consumeFlowPayMessage } from "../src/messaging/consumer.ts";
import type { FlowPayQueueMessage } from "../src/messaging/outbox.ts";

const now = "2026-09-14T12:00:00Z";

describe("escrow orchestration", () => {
  it("releases exact ordered milestones only after each settlement confirms", async () => {
    const organisationId = "org-escrow-orchestration";
    const customerId = "customer-escrow-orchestration";
    const beneficiaryId = "beneficiary-escrow-orchestration";
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organisations (id, name, created_at, updated_at) VALUES (?, 'Escrow orchestration', ?, ?)",
      ).bind(organisationId, now, now),
      env.DB.prepare(
        `INSERT INTO customers (
          id, organisation_id, display_name, status, created_at, updated_at
        ) VALUES (?, ?, 'Escrow customer', 'ACTIVE', ?, ?)`,
      ).bind(customerId, organisationId, now, now),
      env.DB.prepare(
        `INSERT INTO participants (
          id, organisation_id, display_name, participant_type, status,
          created_at, updated_at
        ) VALUES (?, ?, 'Milestone contractor', 'CONTRACTOR', 'ACTIVE', ?, ?)`,
      ).bind(beneficiaryId, organisationId, now, now),
    ]);
    const invoice = await issueInvoice(env.DB, {
      commandId: "escrow-invoice-command",
      organisationId,
      actorId: "finance-author",
      correlationId: "escrow-orchestration-correlation",
      customerId,
      reference: "INV-ESCROW-001",
      assetCode: "USD",
      totalAtomic: "100000",
      assetScale: 2,
      issuedAt: now,
    });
    const payment = await recordPendingPayment(env.DB, {
      commandId: "escrow-payment-command",
      organisationId,
      actorId: "finance-author",
      correlationId: "escrow-orchestration-correlation",
      invoiceId: invoice.id,
      externalReference: "ESCROW-FUNDING-001",
      amountAtomic: "100000",
      receivedAt: now,
    });
    await confirmPayment(env.DB, {
      commandId: "escrow-confirm-payment-command",
      organisationId,
      paymentId: payment.id,
      actorId: "finance-reviewer",
      correlationId: "escrow-orchestration-correlation",
      confirmedAt: now,
    });
    const escrow = await createEscrow(env.DB, {
      commandId: "create-escrow-command",
      organisationId,
      actorId: "finance-author",
      correlationId: "escrow-orchestration-correlation",
      name: "Two exact contractor milestones",
      fundingPaymentId: payment.id,
      milestones: [
        {
          name: "First delivery",
          verificationEventType: "MILESTONE_VERIFIED",
          releaseAmountAtomic: "60000",
        },
        {
          name: "Final delivery",
          verificationEventType: "MILESTONE_VERIFIED",
          releaseAmountAtomic: "40000",
        },
      ],
    });
    await transitionEscrowArrangement(env.DB, {
      commandId: "activate-escrow-command",
      organisationId,
      actorId: "finance-author",
      correlationId: "escrow-orchestration-correlation",
      escrowId: escrow.id,
      action: "ACTIVATE",
      occurredAt: now,
    });
    await transitionEscrowArrangement(env.DB, {
      commandId: "fund-escrow-command",
      organisationId,
      actorId: "finance-reviewer",
      correlationId: "escrow-orchestration-correlation",
      escrowId: escrow.id,
      action: "CONFIRM_FUNDING",
      occurredAt: now,
    });
    const policy = await createApprovalPolicy(env.DB, {
      commandId: "escrow-policy-command",
      organisationId,
      actorId: "finance-author",
      correlationId: "escrow-orchestration-correlation",
      name: "Escrow release control",
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
    await transitionConfiguration(env.DB, {
      commandId: "activate-escrow-policy-command",
      organisationId,
      actorId: "finance-reviewer",
      correlationId: "escrow-orchestration-correlation",
      configurationType: "APPROVAL_POLICY",
      configurationId: policy.id,
      action: "ACTIVATE",
      occurredAt: now,
    });
    const rule = await createSettlementRule(env.DB, {
      commandId: "escrow-rule-command",
      organisationId,
      actorId: "finance-author",
      correlationId: "escrow-orchestration-correlation",
      name: "Verified milestone release",
      triggerEventType: "MILESTONE_VERIFIED",
      triggerSchemaVersion: 1,
      priority: 100,
      effectiveFrom: now,
      conditions: [],
      beneficiaries: [{ kind: "REMAINDER", beneficiaryId }],
      providerPolicy: {
        providerKey: "simulation",
        network: "simnet",
        method: "INDIVIDUAL_TRANSFERS",
      },
      approvalPolicyVersionId: policy.versionId,
    });
    await transitionConfiguration(env.DB, {
      commandId: "activate-escrow-rule-command",
      organisationId,
      actorId: "finance-reviewer",
      correlationId: "escrow-orchestration-correlation",
      configurationType: "SETTLEMENT_RULE",
      configurationId: rule.id,
      action: "ACTIVATE",
      occurredAt: now,
    });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO settlement_provider_sources (
          id, organisation_id, provider, network, source_reference,
          status, created_at, updated_at
        ) VALUES ('escrow-source', ?, 'simulation', 'simnet',
                  'escrow-treasury', 'ACTIVE', ?, ?)`,
      ).bind(organisationId, now, now),
      env.DB.prepare(
        `INSERT INTO participant_settlement_destinations (
          id, organisation_id, participant_id, provider, network, address,
          status, created_at, updated_at
        ) VALUES ('escrow-destination', ?, ?, 'simulation', 'simnet',
                  'sim:contractor', 'ACTIVE', ?, ?)`,
      ).bind(organisationId, beneficiaryId, now, now),
    ]);
    const milestones = await env.DB.prepare(
      "SELECT id FROM escrow_milestones WHERE escrow_arrangement_id = ? ORDER BY position",
    )
      .bind(escrow.id)
      .all<{ id: string }>();
    const provider = new SimulationSettlementProvider("CONFIRMED");
    for (const [index, milestone] of milestones.results.entries()) {
      const verified = await verifyEscrowMilestone(env.DB, {
        verificationId: `verify-escrow-${index}`,
        organisationId,
        escrowId: escrow.id,
        milestoneId: milestone.id,
        actorId: "operations-reviewer",
        correlationId: "escrow-orchestration-correlation",
        evidence: { accepted: true, document: `evidence-${index}` },
        verifiedAt: now,
      });
      expect(verified).toMatchObject({
        ruleOutcome: "MATCHED",
        replayed: false,
      });
      if (!verified.settlementId)
        throw new Error("Expected milestone settlement.");
      const ready = await readyMessage(organisationId, verified.settlementId);
      await consumeFlowPayMessage(env.DB, ready);
      await expect(
        executeSettlementWorkItem(
          env.DB,
          ready.messageId,
          "simulation",
          provider,
        ),
      ).resolves.toMatchObject({ outcome: "CONFIRMED" });
      await expect(
        processEscrowSettlementConfirmed(env.DB, verified.settlementId),
      ).resolves.toBe("RELEASED");
      expect(
        await env.DB.prepare(
          "SELECT state FROM escrow_arrangements WHERE id = ?",
        )
          .bind(escrow.id)
          .first<string>("state"),
      ).toBe(index === 0 ? "PARTIALLY_RELEASED" : "RELEASED");
    }
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM escrow_milestone_releases WHERE escrow_milestone_id IN (SELECT id FROM escrow_milestones WHERE escrow_arrangement_id = ?)",
      )
        .bind(escrow.id)
        .first<number>("count"),
    ).toBe(2);
  });
});

async function readyMessage(
  organisationId: string,
  settlementId: string,
): Promise<FlowPayQueueMessage> {
  const message = await env.DB.prepare(
    `SELECT id AS messageId, organisation_id AS organisationId,
            message_type AS messageType, schema_version AS schemaVersion,
            aggregate_type AS aggregateType, aggregate_id AS aggregateId,
            correlation_id AS correlationId, causation_id AS causationId,
            payload_json AS payloadJson, created_at AS createdAt
     FROM outbox_messages
     WHERE organisation_id = ? AND message_type = 'FLOWPAY_SETTLEMENT_READY'
       AND json_extract(payload_json, '$.settlementId') = ?`,
  )
    .bind(organisationId, settlementId)
    .first<FlowPayQueueMessage>();
  if (!message) throw new Error("Expected ready settlement message.");
  return message;
}
