import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { BusinessCommandConflictError } from "../src/business/create-party.ts";
import {
  JobCommandUnavailableError,
  createJob,
  transitionJob,
} from "../src/business/manage-job.ts";

const now = "2026-09-14T12:00:00Z";

async function fixture(suffix: string) {
  const organisationId = `org-job-${suffix}`;
  const customerId = `customer-job-${suffix}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organisations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(organisationId, `Job organisation ${suffix}`, now, now),
    env.DB.prepare(
      `INSERT INTO customers (
        id, organisation_id, display_name, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
    ).bind(customerId, organisationId, `Customer ${suffix}`, now, now),
  ]);
  return { organisationId, customerId };
}

describe("job authoring and lifecycle", () => {
  it("creates one audited draft for identical concurrent commands", async () => {
    const { organisationId, customerId } = await fixture("create");
    const command = {
      commandId: "command-create-job",
      organisationId,
      actorId: "operations-user",
      correlationId: "correlation-create-job",
      customerId,
      reference: "JOB-001",
      title: "Install customer equipment",
    } as const;
    const results = await Promise.all([
      createJob(env.DB, command),
      createJob(env.DB, command),
    ]);
    expect(results.map(({ replayed }) => replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(results[0]?.id).toBe(results[1]?.id);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE organisation_id = ?",
      )
        .bind(organisationId)
        .first<number>("count"),
    ).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE organisation_id = ? AND action = 'JOB_CREATED'",
      )
        .bind(organisationId)
        .first<number>("count"),
    ).toBe(1);
    await expect(
      createJob(env.DB, { ...command, title: "Different work" }),
    ).rejects.toBeInstanceOf(BusinessCommandConflictError);
  });

  it("records idempotent, append-only transitions and completion evidence", async () => {
    const { organisationId, customerId } = await fixture("lifecycle");
    const job = await createJob(env.DB, {
      commandId: "command-create-lifecycle-job",
      organisationId,
      actorId: "operations-user",
      correlationId: "correlation-lifecycle-job",
      customerId,
      reference: "JOB-002",
      title: "Complete a verified milestone",
    });
    const start = {
      commandId: "command-start-job",
      organisationId,
      actorId: "operations-user",
      correlationId: "correlation-start-job",
      jobId: job.id,
      action: "START",
      occurredAt: "2026-09-14T13:00:00Z",
    } as const;
    await expect(transitionJob(env.DB, start)).resolves.toMatchObject({
      status: "IN_PROGRESS",
      replayed: false,
    });
    await expect(transitionJob(env.DB, start)).resolves.toMatchObject({
      status: "IN_PROGRESS",
      replayed: true,
    });
    await expect(
      transitionJob(env.DB, {
        ...start,
        commandId: "command-complete-job",
        correlationId: "correlation-complete-job",
        action: "COMPLETE",
        occurredAt: "2026-09-14T14:00:00Z",
      }),
    ).resolves.toMatchObject({ status: "COMPLETED" });
    expect(
      await env.DB.prepare("SELECT status, completed_at FROM jobs WHERE id = ?")
        .bind(job.id)
        .first(),
    ).toMatchObject({
      status: "COMPLETED",
      completed_at: "2026-09-14T14:00:00Z",
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM job_state_transitions WHERE job_id = ?",
      )
        .bind(job.id)
        .first<number>("count"),
    ).toBe(2);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM outbox_messages
         WHERE aggregate_id = ? AND message_type IN ('BUSINESS_JOB_STARTED', 'BUSINESS_JOB_COMPLETED')`,
      )
        .bind(job.id)
        .first<number>("count"),
    ).toBe(2);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE aggregate_id = ? AND action IN ('JOB_IN_PROGRESS', 'JOB_COMPLETED')",
      )
        .bind(job.id)
        .first<number>("count"),
    ).toBe(2);
    await expect(
      env.DB.prepare("UPDATE jobs SET status = 'CANCELLED' WHERE id = ?")
        .bind(job.id)
        .run(),
    ).rejects.toThrow(/transition must be recorded/);
    await expect(
      env.DB.prepare("DELETE FROM job_state_transitions WHERE job_id = ?")
        .bind(job.id)
        .run(),
    ).rejects.toThrow(/append-only/);
  });

  it("rejects invalid transitions and requires cancellation evidence", async () => {
    const { organisationId, customerId } = await fixture("controls");
    const job = await createJob(env.DB, {
      commandId: "command-create-controlled-job",
      organisationId,
      actorId: "operations-user",
      correlationId: "correlation-controlled-job",
      customerId,
      reference: "JOB-003",
      title: "Controlled job",
    });
    const base = {
      organisationId,
      actorId: "operations-user",
      jobId: job.id,
      occurredAt: "2026-09-14T15:00:00Z",
    } as const;
    await expect(
      transitionJob(env.DB, {
        ...base,
        commandId: "command-invalid-complete",
        correlationId: "correlation-invalid-complete",
        action: "COMPLETE",
      }),
    ).rejects.toBeInstanceOf(JobCommandUnavailableError);
    await expect(
      transitionJob(env.DB, {
        ...base,
        commandId: "command-invalid-cancel",
        correlationId: "correlation-invalid-cancel",
        action: "CANCEL",
      }),
    ).rejects.toThrow(/requires a reason/);
    await expect(
      transitionJob(env.DB, {
        ...base,
        commandId: "command-cancel-job",
        correlationId: "correlation-cancel-job",
        action: "CANCEL",
        reason: "Customer withdrew the request.",
      }),
    ).resolves.toMatchObject({ status: "CANCELLED" });
  });
});
