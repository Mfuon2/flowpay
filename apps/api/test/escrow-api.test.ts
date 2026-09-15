import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { AuthenticatedPrincipal } from "../src/auth/access-auth.ts";
import { handleApiRequest } from "../src/http/api.ts";

const now = "2026-09-14T12:00:00Z";

describe("authenticated escrow API", () => {
  it("authors, funds, verifies, and reads tenant-scoped escrow evidence", async () => {
    const organisationId = "org-escrow-api";
    const otherOrganisationId = "org-escrow-api-other";
    const paymentId = "payment-escrow-api";
    await seedFunding(organisationId, paymentId);
    await env.DB.prepare(
      "INSERT INTO organisations (id, name, created_at, updated_at) VALUES (?, 'Other', ?, ?)",
    )
      .bind(otherOrganisationId, now, now)
      .run();
    const finance = principal(organisationId, "finance-user", ["FINANCE"]);
    const createRequest = () =>
      new Request("https://flowpay.test/api/v1/escrow", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "api-create-escrow",
        },
        body: JSON.stringify({
          name: "API milestones",
          fundingPaymentId: paymentId,
          milestones: [
            {
              name: "Delivery",
              verificationEventType: "MILESTONE_VERIFIED",
              releaseAmountAtomic: "100000",
            },
          ],
        }),
      });
    const created = await handleApiRequest(createRequest(), env, () =>
      Promise.resolve(finance),
    );
    expect(created?.status).toBe(201);
    const escrow = (await created?.json()) as { id: string; state: string };
    expect(escrow.state).toBe("DRAFT");

    const replayed = await handleApiRequest(createRequest(), env, () =>
      Promise.resolve(finance),
    );
    expect(replayed?.status).toBe(200);
    await expect(replayed?.json()).resolves.toMatchObject({ replayed: true });

    await expect(
      transition(escrow.id, "ACTIVATE", "api-activate-escrow", finance),
    ).resolves.toMatchObject({ status: 201 });
    await expect(
      transition(
        escrow.id,
        "CONFIRM_FUNDING",
        "api-confirm-escrow-funding",
        finance,
      ),
    ).resolves.toMatchObject({ status: 201 });

    const before = await getEscrow(escrow.id, finance);
    expect(before.status).toBe(200);
    const beforeBody: {
      escrow: { state: string };
      milestones: { id: string; verification_id: string | null }[];
    } = await before.json();
    expect(beforeBody.escrow.state).toBe("FUNDED");
    expect(beforeBody.milestones).toHaveLength(1);
    expect(beforeBody.milestones[0]?.verification_id).toBeNull();

    const operations = principal(organisationId, "operations-user", [
      "OPERATIONS",
    ]);
    const verified = await handleApiRequest(
      new Request(
        `https://flowpay.test/api/v1/escrow/${encodeURIComponent(escrow.id)}/milestones/${encodeURIComponent(beforeBody.milestones[0]!.id)}/verifications`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "api-verify-escrow-milestone",
          },
          body: JSON.stringify({
            evidence: { accepted: true, reference: "QC-API-001" },
            verifiedAt: now,
          }),
        },
      ),
      env,
      () => Promise.resolve(operations),
    );
    expect(verified?.status).toBe(201);
    await expect(verified?.json()).resolves.toMatchObject({
      ruleOutcome: "NO_MATCH",
      replayed: false,
    });

    const after = await getEscrow(escrow.id, finance);
    const afterBody: {
      milestones: { verification_id: string | null }[];
      audit: { action: string }[];
    } = await after.json();
    expect(afterBody.milestones[0]?.verification_id).toBe(
      "api-verify-escrow-milestone",
    );
    expect(afterBody.audit.map(({ action }) => action)).toContain(
      "ESCROW_MILESTONE_VERIFIED",
    );

    const hidden = await getEscrow(
      escrow.id,
      principal(otherOrganisationId, "other-user", ["FINANCE"]),
    );
    expect(hidden.status).toBe(404);
  });

  it("rejects escrow authoring without a finance control role", async () => {
    const organisationId = "org-escrow-api-forbidden";
    const paymentId = "payment-escrow-api-forbidden";
    await seedFunding(organisationId, paymentId);
    const response = await handleApiRequest(
      new Request("https://flowpay.test/api/v1/escrow", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "api-forbidden-escrow",
        },
        body: JSON.stringify({
          name: "Forbidden",
          fundingPaymentId: paymentId,
          milestones: [
            {
              name: "Delivery",
              verificationEventType: "MILESTONE_VERIFIED",
              releaseAmountAtomic: "100000",
            },
          ],
        }),
      }),
      env,
      () =>
        Promise.resolve(
          principal(organisationId, "operations-only", ["OPERATIONS"]),
        ),
    );
    expect(response?.status).toBe(403);
  });
});

function principal(
  organisationId: string,
  userId: string,
  roles: AuthenticatedPrincipal["roles"],
): AuthenticatedPrincipal {
  return {
    userId,
    subject: userId,
    email: `${userId}@example.com`,
    organisationId,
    membershipId: `membership:${userId}`,
    roles,
  };
}

async function transition(
  escrowId: string,
  action: string,
  requestId: string,
  actor: AuthenticatedPrincipal,
) {
  const response = await handleApiRequest(
    new Request(
      `https://flowpay.test/api/v1/escrow/${encodeURIComponent(escrowId)}/transitions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": requestId,
        },
        body: JSON.stringify({ action, occurredAt: now }),
      },
    ),
    env,
    () => Promise.resolve(actor),
  );
  return response;
}

async function getEscrow(escrowId: string, actor: AuthenticatedPrincipal) {
  const response = await handleApiRequest(
    new Request(
      `https://flowpay.test/api/v1/escrow/${encodeURIComponent(escrowId)}`,
    ),
    env,
    () => Promise.resolve(actor),
  );
  if (!response) throw new Error("Expected escrow response.");
  return response;
}

async function seedFunding(organisationId: string, paymentId: string) {
  const customerId = `customer:${organisationId}`;
  const invoiceId = `invoice:${organisationId}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organisations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(organisationId, organisationId, now, now),
    env.DB.prepare(
      `INSERT INTO customers (
        id, organisation_id, display_name, status, created_at, updated_at
      ) VALUES (?, ?, 'Escrow customer', 'ACTIVE', ?, ?)`,
    ).bind(customerId, organisationId, now, now),
    env.DB.prepare(
      `INSERT INTO invoices (
        id, organisation_id, customer_id, reference, status, asset_code,
        total_atomic, asset_scale, issued_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'PAID', 'USD', '100000', 2, ?, ?, ?)`,
    ).bind(invoiceId, organisationId, customerId, invoiceId, now, now, now),
    env.DB.prepare(
      `INSERT INTO payments (
        id, organisation_id, invoice_id, external_reference, status,
        asset_code, amount_atomic, asset_scale, received_at, confirmed_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'CONFIRMED', 'USD', '100000', 2, ?, ?, ?, ?)`,
    ).bind(paymentId, organisationId, invoiceId, paymentId, now, now, now, now),
  ]);
}
