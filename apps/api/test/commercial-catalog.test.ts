import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  CommercialRecordUnavailableError,
  createQuote,
  createService,
  transitionQuote,
} from "../src/business/manage-commercial-catalog.ts";
import { processQuoteApprovedMessage } from "../src/business/process-quote-approved-message.ts";
import type { AuthenticatedPrincipal } from "../src/auth/access-auth.ts";
import { handleApiRequest } from "../src/http/api.ts";
import type { FlowPayQueueMessage } from "../src/messaging/outbox.ts";

const now = "2026-09-15T06:00:00Z";

describe("commercial catalog and quotes", () => {
  it("exposes authorised service and quote commands through the API", async () => {
    const fixture = await commercialFixture("api");
    const authenticate = () =>
      Promise.resolve(principal(fixture.organisationId));
    const serviceResponse = await handleApiRequest(
      new Request("https://flowpay.test/api/v1/services", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "api-create-service",
        },
        body: JSON.stringify({
          name: "Paint booth",
          assetCode: "USD",
          unitPriceAtomic: "20000",
          assetScale: 2,
        }),
      }),
      env,
      authenticate,
    );
    expect(serviceResponse?.status).toBe(201);
    const service = (await serviceResponse?.json()) as { id: string };
    const quoteResponse = await handleApiRequest(
      new Request("https://flowpay.test/api/v1/quotes", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "api-create-quote",
        },
        body: JSON.stringify({
          customerId: fixture.customerId,
          jobId: fixture.jobId,
          reference: "QTE-API-001",
          assetCode: "USD",
          assetScale: 2,
          lines: [
            {
              serviceId: service.id,
              description: "Paint booth use",
              quantityAtomic: "1",
              quantityScale: 0,
              unitPriceAtomic: "20000",
            },
          ],
        }),
      }),
      env,
      authenticate,
    );
    expect(quoteResponse?.status).toBe(201);
    const quote = (await quoteResponse?.json()) as { id: string };
    for (const [action, key] of [
      ["ISSUE", "api-issue-quote"],
      ["APPROVE", "api-approve-quote"],
    ] as const) {
      const response = await handleApiRequest(
        new Request(
          `https://flowpay.test/api/v1/quotes/${encodeURIComponent(quote.id)}/transitions`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": key,
            },
            body: JSON.stringify({ action }),
          },
        ),
        env,
        authenticate,
      );
      expect(response?.status).toBe(201);
    }
    const list = await handleApiRequest(
      new Request("https://flowpay.test/api/v1/quotes"),
      env,
      authenticate,
    );
    expect(list?.status).toBe(200);
    await expect(list?.json()).resolves.toMatchObject({
      items: [{ id: quote.id, status: "APPROVED", amount_atomic: "20000" }],
    });
  });

  it("authors exact services and quote lines idempotently", async () => {
    const fixture = await commercialFixture("exact");
    const service = await createService(env.DB, {
      ...context(fixture.organisationId, "create-service-exact"),
      name: "Mechanical labour",
      assetCode: "USD",
      unitPriceAtomic: "9007199254740993123456",
      assetScale: 2,
    });
    const command = {
      ...context(fixture.organisationId, "create-quote-exact"),
      customerId: fixture.customerId,
      jobId: fixture.jobId,
      reference: "QTE-EXACT-001",
      assetCode: "USD",
      assetScale: 2,
      lines: [
        {
          serviceId: service.id,
          description: "Two labour units",
          quantityAtomic: "2",
          quantityScale: 0,
          unitPriceAtomic: "9007199254740993123456",
        },
        {
          description: "One and a half consumable units",
          quantityAtomic: "15",
          quantityScale: 1,
          unitPriceAtomic: "200",
        },
      ],
    } as const;

    const created = await createQuote(env.DB, command);
    expect(created).toMatchObject({
      status: "DRAFT",
      totalAtomic: "18014398509481986247212",
      assetCode: "USD",
      assetScale: 2,
      replayed: false,
    });
    await expect(createQuote(env.DB, command)).resolves.toMatchObject({
      id: created.id,
      replayed: true,
    });
    expect(
      (
        await env.DB.prepare(
          "SELECT line_total_atomic FROM quote_lines WHERE quote_id = ? ORDER BY position",
        )
          .bind(created.id)
          .all<{ line_total_atomic: string }>()
      ).results.map(({ line_total_atomic }) => line_total_atomic),
    ).toEqual(["18014398509481986246912", "300"]);
  });

  it("enforces quote state history and adapts approval into a generic event", async () => {
    const fixture = await commercialFixture("lifecycle");
    const quote = await createQuote(env.DB, {
      ...context(fixture.organisationId, "create-quote-lifecycle"),
      customerId: fixture.customerId,
      reference: "QTE-LIFECYCLE-001",
      assetCode: "USD",
      assetScale: 2,
      lines: [
        {
          description: "Inspection",
          quantityAtomic: "1",
          quantityScale: 0,
          unitPriceAtomic: "10000",
        },
      ],
    });
    await expect(
      env.DB.prepare("UPDATE quotes SET status = 'APPROVED' WHERE id = ?")
        .bind(quote.id)
        .run(),
    ).rejects.toThrow(/transition must be recorded/);
    await transitionQuote(env.DB, {
      ...context(fixture.organisationId, "issue-quote-lifecycle"),
      quoteId: quote.id,
      action: "ISSUE",
      occurredAt: now,
    });
    const approved = await transitionQuote(env.DB, {
      ...context(fixture.organisationId, "approve-quote-lifecycle"),
      quoteId: quote.id,
      action: "APPROVE",
      occurredAt: "2026-09-15T06:01:00Z",
    });
    expect(approved.status).toBe("APPROVED");
    const message = await env.DB.prepare(
      `SELECT id AS messageId, organisation_id AS organisationId,
              message_type AS messageType, schema_version AS schemaVersion,
              aggregate_type AS aggregateType, aggregate_id AS aggregateId,
              correlation_id AS correlationId, causation_id AS causationId,
              payload_json AS payloadJson, created_at AS createdAt
       FROM outbox_messages
       WHERE organisation_id = ? AND message_type = 'BUSINESS_QUOTE_APPROVED'`,
    )
      .bind(fixture.organisationId)
      .first<FlowPayQueueMessage>();
    if (!message) throw new Error("Quote approval message was not recorded.");

    const processed = await processQuoteApprovedMessage(env.DB, message);
    expect(processed.outcome).toBe("NO_MATCH");
    await expect(
      env.DB.prepare(
        "SELECT event_type FROM business_events WHERE aggregate_id = ?",
      )
        .bind(quote.id)
        .first<string>("event_type"),
    ).resolves.toBe("QUOTE_APPROVED");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM quote_state_transitions WHERE quote_id = ?",
      )
        .bind(quote.id)
        .first<number>("count"),
    ).toBe(2);
  });

  it("rejects inexact quantities and cross-tenant service references", async () => {
    const fixture = await commercialFixture("rejections");
    await expect(
      createQuote(env.DB, {
        ...context(fixture.organisationId, "create-quote-inexact"),
        customerId: fixture.customerId,
        reference: "QTE-INEXACT",
        assetCode: "USD",
        assetScale: 2,
        lines: [
          {
            description: "Fractional unit",
            quantityAtomic: "1",
            quantityScale: 1,
            unitPriceAtomic: "1",
          },
        ],
      }),
    ).rejects.toThrow(/must be exact/);

    const other = await commercialFixture("other-tenant");
    const hiddenService = await createService(env.DB, {
      ...context(other.organisationId, "create-hidden-service"),
      name: "Hidden service",
      assetCode: "USD",
      unitPriceAtomic: "100",
      assetScale: 2,
    });
    await expect(
      createQuote(env.DB, {
        ...context(fixture.organisationId, "create-quote-hidden-service"),
        customerId: fixture.customerId,
        reference: "QTE-HIDDEN-SERVICE",
        assetCode: "USD",
        assetScale: 2,
        lines: [
          {
            serviceId: hiddenService.id,
            description: "Hidden",
            quantityAtomic: "1",
            quantityScale: 0,
            unitPriceAtomic: "100",
          },
        ],
      }),
    ).rejects.toBeInstanceOf(CommercialRecordUnavailableError);
  });
});

async function commercialFixture(suffix: string) {
  const organisationId = `org-commercial-${suffix}`;
  const customerId = `customer-commercial-${suffix}`;
  const jobId = `job-commercial-${suffix}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organisations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(organisationId, organisationId, now, now),
    env.DB.prepare(
      `INSERT INTO customers (
        id, organisation_id, display_name, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
    ).bind(customerId, organisationId, customerId, now, now),
    env.DB.prepare(
      `INSERT INTO jobs (
        id, organisation_id, customer_id, reference, title, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'Commercial job', 'DRAFT', ?, ?)`,
    ).bind(jobId, organisationId, customerId, jobId, now, now),
  ]);
  return { organisationId, customerId, jobId };
}

function context(organisationId: string, commandId: string) {
  return {
    commandId,
    organisationId,
    actorId: `actor-${organisationId}`,
    correlationId: `correlation-${commandId}`,
  };
}

function principal(organisationId: string): AuthenticatedPrincipal {
  return {
    userId: `user-${organisationId}`,
    subject: `subject-${organisationId}`,
    email: `${organisationId}@example.com`,
    organisationId,
    membershipId: `membership-${organisationId}`,
    roles: ["FINANCE"],
  };
}
