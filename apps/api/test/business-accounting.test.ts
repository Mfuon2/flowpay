import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { processBusinessEventAccounting } from "../src/accounting/process-business-event-accounting.ts";
import { processSettlementObligation } from "../src/accounting/process-settlement-obligation.ts";
import {
  issueInvoice,
  recordPendingPayment,
} from "../src/business/author-financial-document.ts";
import { confirmPayment } from "../src/business/confirm-payment.ts";
import { processInvoiceIssuedMessage } from "../src/business/process-invoice-issued-message.ts";
import { processPaymentConfirmedMessage } from "../src/business/process-payment-confirmed-message.ts";
import { consumeFlowPayMessage } from "../src/messaging/consumer.ts";
import type { FlowPayQueueMessage } from "../src/messaging/outbox.ts";

const now = "2026-09-14T12:00:00Z";

describe("business-event accounting", () => {
  it("posts invoice recognition and confirmed receipt exactly once", async () => {
    const organisationId = "org-business-accounting";
    const customerId = "customer-business-accounting";
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organisations (id, name, created_at, updated_at) VALUES (?, 'Business accounting', ?, ?)",
      ).bind(organisationId, now, now),
      env.DB.prepare(
        `INSERT INTO customers (
          id, organisation_id, display_name, status, created_at, updated_at
        ) VALUES (?, ?, 'Accounting customer', 'ACTIVE', ?, ?)`,
      ).bind(customerId, organisationId, now, now),
      account(
        "cash-business-accounting",
        organisationId,
        "1000",
        "Cash",
        "ASSET",
      ),
      account(
        "receivable-business-accounting",
        organisationId,
        "1100",
        "Receivable",
        "ASSET",
      ),
      account(
        "revenue-business-accounting",
        organisationId,
        "4000",
        "Revenue",
        "REVENUE",
      ),
      ...policyStatements(
        "invoice-business-accounting",
        organisationId,
        "INVOICE_ISSUED",
        {
          kind: "INVOICE_ISSUED_V1",
          assetCode: "USD",
          scale: 2,
          receivableDebitAccountId: "receivable-business-accounting",
          revenueCreditAccountId: "revenue-business-accounting",
        },
      ),
      ...policyStatements(
        "receipt-business-accounting",
        organisationId,
        "PAYMENT_CONFIRMED",
        {
          kind: "PAYMENT_RECEIPT_V1",
          assetCode: "USD",
          scale: 2,
          cashDebitAccountId: "cash-business-accounting",
          receivableCreditAccountId: "receivable-business-accounting",
        },
      ),
    ]);
    const invoice = await issueInvoice(env.DB, {
      commandId: "issue-business-accounting",
      organisationId,
      actorId: "sales-user",
      correlationId: "correlation-business-accounting",
      customerId,
      reference: "INV-ACCOUNTING-001",
      assetCode: "USD",
      totalAtomic: "100000",
      assetScale: 2,
      issuedAt: now,
    });
    const invoiceMessage = await outboxMessage(
      "BUSINESS_INVOICE_ISSUED",
      invoice.id,
    );
    await expect(consumeFlowPayMessage(env.DB, invoiceMessage)).resolves.toBe(
      "PROCESSED",
    );
    const invoiceEvent = await processInvoiceIssuedMessage(
      env.DB,
      invoiceMessage,
    );
    const invoicePosting = await processBusinessEventAccounting(
      env.DB,
      invoiceEvent.eventId,
    );
    expect(invoicePosting).toMatchObject({
      policyKind: "INVOICE_ISSUED_V1",
      replayed: false,
    });

    const payment = await recordPendingPayment(env.DB, {
      commandId: "payment-business-accounting",
      organisationId,
      actorId: "finance-user",
      correlationId: "correlation-business-accounting",
      invoiceId: invoice.id,
      externalReference: "PAY-ACCOUNTING-001",
      amountAtomic: "100000",
      receivedAt: now,
    });
    await confirmPayment(env.DB, {
      commandId: "confirm-business-accounting",
      organisationId,
      paymentId: payment.id,
      actorId: "finance-reviewer",
      correlationId: "correlation-business-accounting",
      confirmedAt: now,
    });
    const paymentMessage = await outboxMessage(
      "BUSINESS_PAYMENT_CONFIRMED",
      payment.id,
    );
    const paymentEvent = await processPaymentConfirmedMessage(
      env.DB,
      paymentMessage,
    );
    const receiptPosting = await processBusinessEventAccounting(
      env.DB,
      paymentEvent.eventId,
    );
    expect(receiptPosting).toMatchObject({
      policyKind: "PAYMENT_RECEIPT_V1",
      replayed: false,
    });
    await expect(
      processBusinessEventAccounting(env.DB, paymentEvent.eventId),
    ).resolves.toMatchObject({ replayed: true });
    const lines = await env.DB.prepare(
      `SELECT je.posting_purpose, jl.direction, la.code, jl.amount_atomic
       FROM journal_entries je
       JOIN journal_lines jl ON jl.journal_entry_id = je.id
       JOIN ledger_accounts la ON la.id = jl.ledger_account_id
       WHERE je.organisation_id = ?
       ORDER BY je.posting_purpose, jl.position`,
    )
      .bind(organisationId)
      .all<{
        posting_purpose: string;
        direction: string;
        code: string;
        amount_atomic: string;
      }>();
    expect(lines.results).toEqual([
      {
        posting_purpose: "INVOICE_ISSUED_V1",
        direction: "DEBIT",
        code: "1100",
        amount_atomic: "100000",
      },
      {
        posting_purpose: "INVOICE_ISSUED_V1",
        direction: "CREDIT",
        code: "4000",
        amount_atomic: "100000",
      },
      {
        posting_purpose: "PAYMENT_RECEIPT_V1",
        direction: "DEBIT",
        code: "1000",
        amount_atomic: "100000",
      },
      {
        posting_purpose: "PAYMENT_RECEIPT_V1",
        direction: "CREDIT",
        code: "1100",
        amount_atomic: "100000",
      },
    ]);
  });

  it("posts only explicitly mapped beneficiary obligations", async () => {
    const fixture = await seedSettlementObligation();
    const result = await processSettlementObligation(env.DB, fixture.message);
    expect(result).toMatchObject({ outcome: "POSTED", replayed: false });
    await expect(
      processSettlementObligation(env.DB, fixture.message),
    ).resolves.toMatchObject({ replayed: true });
    const lines = await env.DB.prepare(
      `SELECT la.code, jl.direction, jl.amount_atomic
       FROM journal_lines jl JOIN ledger_accounts la ON la.id = jl.ledger_account_id
       WHERE jl.journal_entry_id = ? ORDER BY jl.position`,
    )
      .bind(result.journalEntryId)
      .all<{ code: string; direction: string; amount_atomic: string }>();
    expect(lines.results).toEqual([
      { code: "5100", direction: "DEBIT", amount_atomic: "70000" },
      { code: "2100", direction: "CREDIT", amount_atomic: "70000" },
    ]);
  });
});

async function outboxMessage(messageType: string, aggregateId: string) {
  const message = await env.DB.prepare(
    `SELECT id AS messageId, organisation_id AS organisationId,
            message_type AS messageType, schema_version AS schemaVersion,
            aggregate_type AS aggregateType, aggregate_id AS aggregateId,
            correlation_id AS correlationId, causation_id AS causationId,
            payload_json AS payloadJson, created_at AS createdAt
     FROM outbox_messages WHERE message_type = ? AND aggregate_id = ?`,
  )
    .bind(messageType, aggregateId)
    .first<FlowPayQueueMessage>();
  if (!message) throw new Error(`Expected ${messageType} message.`);
  return message;
}

function account(
  id: string,
  organisationId: string,
  code: string,
  name: string,
  type: "ASSET" | "LIABILITY" | "REVENUE" | "EXPENSE",
) {
  return env.DB.prepare(
    `INSERT INTO ledger_accounts (
      id, organisation_id, code, name, account_type, asset_code,
      asset_scale, status, created_at
    ) VALUES (?, ?, ?, ?, ?, 'USD', 2, 'ACTIVE', ?)`,
  ).bind(id, organisationId, code, name, type, now);
}

function policyStatements(
  id: string,
  organisationId: string,
  trigger: string,
  body: object,
) {
  return [
    env.DB.prepare(
      `INSERT INTO accounting_posting_policies (
          id, organisation_id, name, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
    ).bind(id, organisationId, id, now, now),
    env.DB.prepare(
      `INSERT INTO accounting_posting_policy_versions (
          id, policy_id, version, trigger_event_type, priority, effective_from,
          policy_json, created_by, created_at
        ) VALUES (?, ?, 1, ?, 100, ?, ?, 'test', ?)`,
    ).bind(`${id}:v1`, id, trigger, now, JSON.stringify(body), now),
  ] as const;
}

async function seedSettlementObligation() {
  const organisationId = "org-settlement-obligation";
  const external = "participant-obligation-external";
  const internal = "participant-obligation-internal";
  const eventId = "event-settlement-obligation";
  const ruleId = "rule-settlement-obligation";
  const ruleVersionId = "rule-version-settlement-obligation";
  const settlementId = "settlement-obligation";
  const policyId = "policy-settlement-obligation";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organisations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(organisationId, organisationId, now, now),
    env.DB.prepare(
      `INSERT INTO participants (
        id, organisation_id, display_name, participant_type, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'CONTRACTOR', 'ACTIVE', ?, ?),
               (?, ?, ?, 'ORGANISATION', 'ACTIVE', ?, ?)`,
    ).bind(
      external,
      organisationId,
      external,
      now,
      now,
      internal,
      organisationId,
      internal,
      now,
      now,
    ),
    account(
      "expense-settlement-obligation",
      organisationId,
      "5100",
      "Contractor expense",
      "EXPENSE",
    ),
    account(
      "clearing-settlement-obligation",
      organisationId,
      "2100",
      "Settlement clearing",
      "LIABILITY",
    ),
    env.DB.prepare(
      `INSERT INTO settlement_rules (
        id, organisation_id, name, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
    ).bind(ruleId, organisationId, ruleId, now, now),
    env.DB.prepare(
      `INSERT INTO settlement_rule_versions (
        id, rule_id, version, trigger_event_type, trigger_schema_version,
        priority, effective_from, conditions_json, beneficiaries_json,
        provider_policy_json, created_by, created_at
      ) VALUES (?, ?, 1, 'PAYMENT_CONFIRMED', 1, 1, ?, '[]', '[]', '{}', 'test', ?)`,
    ).bind(ruleVersionId, ruleId, now, now),
    env.DB.prepare(
      `INSERT INTO business_events (
        id, organisation_id, source, external_event_id, event_type,
        schema_version, aggregate_type, aggregate_id, occurred_at, recorded_at,
        correlation_id, payload_json
      ) VALUES (?, ?, 'test', ?, 'PAYMENT_CONFIRMED', 1, 'PAYMENT', ?, ?, ?, ?, '{}')`,
    ).bind(eventId, organisationId, eventId, eventId, now, now, eventId),
    env.DB.prepare(
      `INSERT INTO settlements (
        id, organisation_id, source_event_id, rule_version_id, asset_code,
        amount_atomic, asset_scale, state, state_version,
        evaluation_evidence_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'USD', '100000', 2, 'PENDING_APPROVAL', 0, '{}', ?, ?)`,
    ).bind(settlementId, organisationId, eventId, ruleVersionId, now, now),
    env.DB.prepare(
      `INSERT INTO settlement_distributions (
        id, settlement_id, beneficiary_id, position, calculation_kind,
        calculation_json, asset_code, amount_atomic, asset_scale, state,
        created_at, updated_at
      ) VALUES ('distribution-obligation-external', ?, ?, 0, 'PERCENTAGE', '{}', 'USD', '70000', 2, 'PENDING', ?, ?),
               ('distribution-obligation-internal', ?, ?, 1, 'REMAINDER', '{}', 'USD', '30000', 2, 'PENDING', ?, ?)`,
    ).bind(settlementId, external, now, now, settlementId, internal, now, now),
    env.DB.prepare(
      `INSERT INTO accounting_posting_policies (
        id, organisation_id, name, status, created_at, updated_at
      ) VALUES (?, ?, 'Settlement obligations', 'ACTIVE', ?, ?)`,
    ).bind(policyId, organisationId, now, now),
    env.DB.prepare(
      `INSERT INTO accounting_posting_policy_versions (
        id, policy_id, version, trigger_event_type, priority, effective_from,
        policy_json, created_by, created_at
      ) VALUES (?, ?, 1, 'FLOWPAY_SETTLEMENT_CREATED', 100, ?, ?, 'test', ?)`,
    ).bind(
      `${policyId}:v1`,
      policyId,
      now,
      JSON.stringify({
        kind: "SETTLEMENT_OBLIGATION_V1",
        assetCode: "USD",
        scale: 2,
        beneficiaryAccounts: [
          {
            beneficiaryId: external,
            debitAccountId: "expense-settlement-obligation",
            creditAccountId: "clearing-settlement-obligation",
          },
        ],
      }),
      now,
    ),
  ]);
  const message: FlowPayQueueMessage = {
    messageId: "message-settlement-obligation",
    organisationId,
    messageType: "FLOWPAY_SETTLEMENT_CREATED",
    schemaVersion: 1,
    aggregateType: "SETTLEMENT",
    aggregateId: settlementId,
    correlationId: eventId,
    causationId: eventId,
    payloadJson: JSON.stringify({ settlementId }),
    createdAt: now,
  };
  return { message };
}
