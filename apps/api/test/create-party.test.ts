import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  BusinessCommandConflictError,
  createCustomer,
  createParticipant,
} from "../src/business/create-party.ts";

const now = "2026-09-14T12:00:00Z";

async function organisation(suffix: string): Promise<string> {
  const id = `org-party-${suffix}`;
  await env.DB.prepare(
    "INSERT INTO organisations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
  )
    .bind(id, `Party organisation ${suffix}`, now, now)
    .run();
  return id;
}

describe("business party authoring", () => {
  it("creates one audited customer for identical concurrent commands", async () => {
    const organisationId = await organisation("customer");
    const command = {
      commandId: "command-create-customer",
      organisationId,
      actorId: "operations-user",
      correlationId: "correlation-create-customer",
      displayName: "  Grace Wanjiku  ",
      email: "GRACE@EXAMPLE.COM",
    } as const;
    const results = await Promise.all([
      createCustomer(env.DB, command),
      createCustomer(env.DB, command),
    ]);
    expect(results.map(({ replayed }) => replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(results[0]?.id).toBe(results[1]?.id);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM customers WHERE organisation_id = ?",
      )
        .bind(organisationId)
        .first<number>("count"),
    ).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE organisation_id = ? AND action = 'CUSTOMER_CREATED'",
      )
        .bind(organisationId)
        .first<number>("count"),
    ).toBe(1);
    await expect(
      createCustomer(env.DB, { ...command, displayName: "Different customer" }),
    ).rejects.toBeInstanceOf(BusinessCommandConflictError);
  });

  it("creates an allow-listed generic participant without vertical logic", async () => {
    const organisationId = await organisation("participant");
    await expect(
      createParticipant(env.DB, {
        commandId: "command-create-participant",
        organisationId,
        actorId: "operations-user",
        correlationId: "correlation-create-participant",
        displayName: "Acme Supplies",
        participantType: "SUPPLIER",
      }),
    ).resolves.toMatchObject({
      displayName: "Acme Supplies",
      status: "ACTIVE",
      replayed: false,
    });
    await expect(
      createParticipant(env.DB, {
        commandId: "command-invalid-participant",
        organisationId,
        actorId: "operations-user",
        correlationId: "correlation-invalid-participant",
        displayName: "Invalid",
        participantType: "GARAGE" as "SUPPLIER",
      }),
    ).rejects.toThrow(/not supported/);
  });
});
