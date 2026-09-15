import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { AuthenticatedPrincipal } from "../src/auth/access-auth.ts";
import { handleApiRequest } from "../src/http/api.ts";

const now = "2026-09-14T12:00:00Z";

describe("operations API", () => {
  it("reports tenant-scoped financial exceptions without provider secrets", async () => {
    const organisationId = "org-operations-visible";
    const hiddenOrganisationId = "org-operations-hidden";
    await env.DB.batch([
      organisation(organisationId),
      organisation(hiddenOrganisationId),
      outbox("outbox-operations-visible", organisationId),
      outbox("outbox-operations-hidden", hiddenOrganisationId),
      queueFailure("queue-operations-visible", organisationId),
      queueFailure("queue-operations-hidden", hiddenOrganisationId),
    ]);

    const response = await handleApiRequest(
      new Request("https://flowpay.test/api/v1/operations"),
      env,
      () => Promise.resolve(principal(organisationId, ["FINANCE"])),
    );

    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      items: readonly { id: string; count: number }[];
    };
    expect(body.items.find(({ id }) => id === "outbox")?.count).toBe(1);
    expect(body.items.find(({ id }) => id === "queue")?.count).toBe(1);
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("restricts operations visibility to financial control roles", async () => {
    const organisationId = "org-operations-forbidden";
    await env.DB.prepare(
      "INSERT INTO organisations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    )
      .bind(organisationId, "Forbidden operations", now, now)
      .run();

    const response = await handleApiRequest(
      new Request("https://flowpay.test/api/v1/operations"),
      env,
      () => Promise.resolve(principal(organisationId, ["OPERATIONS"])),
    );

    expect(response?.status).toBe(403);
  });
});

function organisation(id: string) {
  return env.DB.prepare(
    "INSERT INTO organisations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).bind(id, id, now, now);
}

function outbox(id: string, organisationId: string) {
  return env.DB.prepare(
    `INSERT INTO outbox_messages (
      id, organisation_id, message_type, schema_version, aggregate_type,
      aggregate_id, correlation_id, payload_json, created_at
    ) VALUES (?, ?, 'TEST_EVENT', 1, 'TEST', ?, ?, '{}', ?)`,
  ).bind(id, organisationId, id, id, now);
}

function queueFailure(id: string, organisationId: string) {
  return env.DB.prepare(
    `INSERT INTO queue_message_failures (
      id, queue_name, queue_message_id, attempts, error_code,
      error_message, recorded_at, organisation_id
    ) VALUES (?, 'flowpay-events', ?, 1, 'INVALID', 'Invalid event', ?, ?)`,
  ).bind(id, id, now, organisationId);
}

function principal(
  organisationId: string,
  roles: AuthenticatedPrincipal["roles"],
): AuthenticatedPrincipal {
  return {
    userId: `user-${organisationId}`,
    subject: `subject-${organisationId}`,
    email: `${organisationId}@example.com`,
    organisationId,
    membershipId: `membership-${organisationId}`,
    roles,
  };
}
