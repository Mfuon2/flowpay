import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  FinancialDocumentUnavailableError,
  issueInvoice,
  recordPendingPayment,
} from "../src/business/author-financial-document.ts";
import { BusinessCommandConflictError } from "../src/business/create-party.ts";
import {
  InvoiceVoidUnavailableError,
  voidInvoice,
} from "../src/business/void-invoice.ts";

const now = "2026-09-14T12:00:00Z";

async function fixture(suffix: string) {
  const organisationId = `org-document-${suffix}`;
  const customerId = `customer-document-${suffix}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organisations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(organisationId, `Document organisation ${suffix}`, now, now),
    env.DB.prepare(
      `INSERT INTO customers (
        id, organisation_id, display_name, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
    ).bind(customerId, organisationId, `Customer ${suffix}`, now, now),
  ]);
  return { organisationId, customerId };
}

describe("invoice and payment authoring", () => {
  it("issues one exact, audited invoice for concurrent retries", async () => {
    const { organisationId, customerId } = await fixture("invoice");
    const command = {
      commandId: "command-issue-invoice",
      organisationId,
      actorId: "finance-user",
      correlationId: "correlation-issue-invoice",
      customerId,
      reference: "INV-EXACT-001",
      assetCode: "USDC",
      totalAtomic: "9007199254740993123456",
      assetScale: 6,
      issuedAt: now,
    } as const;
    const results = await Promise.all([
      issueInvoice(env.DB, command),
      issueInvoice(env.DB, command),
    ]);
    expect(results.map(({ replayed }) => replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(results[0]?.id).toBe(results[1]?.id);
    expect(
      await env.DB.prepare(
        "SELECT total_atomic, asset_scale FROM invoices WHERE id = ?",
      )
        .bind(results[0]?.id)
        .first(),
    ).toMatchObject({
      total_atomic: "9007199254740993123456",
      asset_scale: 6,
    });
    await expect(
      issueInvoice(env.DB, { ...command, totalAtomic: "1" }),
    ).rejects.toBeInstanceOf(BusinessCommandConflictError);
  });

  it("records an idempotent pending receipt and preserves exact invoice bounds", async () => {
    const { organisationId, customerId } = await fixture("payment");
    const invoice = await issueInvoice(env.DB, {
      commandId: "command-payment-invoice",
      organisationId,
      actorId: "finance-user",
      correlationId: "correlation-payment-invoice",
      customerId,
      reference: "INV-PAYMENT-001",
      assetCode: "USD",
      totalAtomic: "100000",
      assetScale: 2,
      issuedAt: now,
    });
    const command = {
      commandId: "command-record-payment",
      organisationId,
      actorId: "finance-user",
      correlationId: "correlation-record-payment",
      invoiceId: invoice.id,
      externalReference: "BANK-001",
      amountAtomic: "100000",
      receivedAt: "2026-09-14T13:00:00Z",
    } as const;
    await expect(recordPendingPayment(env.DB, command)).resolves.toMatchObject({
      status: "PENDING",
      amountAtomic: "100000",
      replayed: false,
    });
    await expect(recordPendingPayment(env.DB, command)).resolves.toMatchObject({
      replayed: true,
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE organisation_id = ? AND action = 'PAYMENT_RECORDED'",
      )
        .bind(organisationId)
        .first<number>("count"),
    ).toBe(1);
    await expect(
      recordPendingPayment(env.DB, {
        ...command,
        commandId: "command-overpayment",
        externalReference: "BANK-OVERPAYMENT",
        amountAtomic: "100001",
      }),
    ).rejects.toThrow(/one full payment equal to the invoice total/);
  });

  it("rejects cross-customer job links and non-issued payment targets", async () => {
    const { organisationId, customerId } = await fixture("scope");
    const otherCustomerId = "customer-document-scope-other";
    const jobId = "job-document-scope";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO customers (
          id, organisation_id, display_name, status, created_at, updated_at
        ) VALUES (?, ?, 'Other customer', 'ACTIVE', ?, ?)`,
      ).bind(otherCustomerId, organisationId, now, now),
      env.DB.prepare(
        `INSERT INTO jobs (
          id, organisation_id, customer_id, reference, title, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'JOB-SCOPE', 'Scoped job', 'DRAFT', ?, ?)`,
      ).bind(jobId, organisationId, otherCustomerId, now, now),
    ]);
    await expect(
      issueInvoice(env.DB, {
        commandId: "command-cross-customer-invoice",
        organisationId,
        actorId: "finance-user",
        correlationId: "correlation-cross-customer-invoice",
        customerId,
        jobId,
        reference: "INV-SCOPE",
        assetCode: "USD",
        totalAtomic: "100",
        assetScale: 2,
        issuedAt: now,
      }),
    ).rejects.toBeInstanceOf(FinancialDocumentUnavailableError);
  });

  it("voids an unpaid invoice once with append-only evidence", async () => {
    const { organisationId, customerId } = await fixture("void");
    const invoice = await issueInvoice(env.DB, {
      commandId: "command-void-invoice-create",
      organisationId,
      actorId: "finance-user",
      correlationId: "correlation-void-invoice",
      customerId,
      reference: "INV-VOID-001",
      assetCode: "USD",
      totalAtomic: "10000",
      assetScale: 2,
      issuedAt: now,
    });
    const command = {
      commandId: "command-void-invoice",
      organisationId,
      invoiceId: invoice.id,
      actorId: "finance-user",
      correlationId: "correlation-void-invoice",
      reason: "Customer obligation was entered in error.",
      occurredAt: "2026-09-14T13:00:00Z",
    } as const;
    await expect(voidInvoice(env.DB, command)).resolves.toMatchObject({
      status: "VOID",
      replayed: false,
    });
    await expect(voidInvoice(env.DB, command)).resolves.toMatchObject({
      replayed: true,
    });
    await expect(
      env.DB.prepare("UPDATE invoices SET status = 'PAID' WHERE id = ?")
        .bind(invoice.id)
        .run(),
    ).rejects.toThrow(/transition must be recorded/);
    await expect(
      env.DB.prepare(
        "DELETE FROM invoice_state_transitions WHERE invoice_id = ?",
      )
        .bind(invoice.id)
        .run(),
    ).rejects.toThrow(/append-only/);
  });

  it("does not void an invoice after a payment has been recorded", async () => {
    const { organisationId, customerId } = await fixture("void-payment");
    const invoice = await issueInvoice(env.DB, {
      commandId: "command-void-payment-invoice",
      organisationId,
      actorId: "finance-user",
      correlationId: "correlation-void-payment",
      customerId,
      reference: "INV-VOID-PAYMENT",
      assetCode: "USD",
      totalAtomic: "10000",
      assetScale: 2,
      issuedAt: now,
    });
    await recordPendingPayment(env.DB, {
      commandId: "command-void-payment-record",
      organisationId,
      actorId: "finance-user",
      correlationId: "correlation-void-payment",
      invoiceId: invoice.id,
      externalReference: "PAYMENT-BEFORE-VOID",
      amountAtomic: "10000",
      receivedAt: now,
    });
    await expect(
      voidInvoice(env.DB, {
        commandId: "command-void-with-payment",
        organisationId,
        invoiceId: invoice.id,
        actorId: "finance-user",
        correlationId: "correlation-void-payment",
        reason: "Attempted void",
        occurredAt: now,
      }),
    ).rejects.toBeInstanceOf(InvoiceVoidUnavailableError);
  });
});
