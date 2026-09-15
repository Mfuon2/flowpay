import type { JsonValue } from "@flowpay/domain";

import { canonicalJson, hashCanonicalJson } from "../flowpay/canonical-json.ts";
import {
  auditStatement,
  outboxStatement,
} from "../flowpay/evidence-statements.ts";
import { BusinessCommandConflictError } from "./create-party.ts";

type Context = Readonly<{
  commandId: string;
  organisationId: string;
  actorId: string;
  correlationId: string;
}>;

export type CreateJobCommand = Context &
  Readonly<{
    customerId: string;
    reference: string;
    title: string;
    description?: string;
  }>;

export type TransitionJobCommand = Context &
  Readonly<{
    jobId: string;
    action: "START" | "COMPLETE" | "CANCEL";
    reason?: string;
    occurredAt: string;
  }>;

export class JobCommandUnavailableError extends Error {
  override readonly name = "JobCommandUnavailableError";
}

type Receipt = Readonly<{
  command_type: string;
  command_fingerprint: string;
  result_json: string;
}>;

type JobRow = Readonly<{ status: JobStatus }>;
type JobStatus = "DRAFT" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

export type CreateJobResult = Readonly<{
  id: string;
  organisationId: string;
  reference: string;
  status: "DRAFT";
  replayed: boolean;
}>;

export type TransitionJobResult = Readonly<{
  id: string;
  organisationId: string;
  status: JobStatus;
  replayed: boolean;
}>;

export async function createJob(
  database: D1Database,
  command: CreateJobCommand,
): Promise<CreateJobResult> {
  const normalized = {
    ...context(command),
    customerId: required("Customer ID", command.customerId),
    reference: required("Job reference", command.reference),
    title: required("Job title", command.title),
    ...(optional(command.description) === undefined
      ? {}
      : { description: optional(command.description) }),
  };
  const commandType = "CREATE_JOB";
  const fingerprint = await hashCanonicalJson({ commandType, ...normalized });
  const existing = await receipt(database, command.commandId);
  if (existing)
    return replay<CreateJobResult>(existing, commandType, fingerprint);
  const customer = await database
    .prepare(
      "SELECT id FROM customers WHERE id = ? AND organisation_id = ? AND status = 'ACTIVE'",
    )
    .bind(normalized.customerId, normalized.organisationId)
    .first<string>("id");
  if (!customer) {
    throw new JobCommandUnavailableError(
      "The job requires an active customer in this organisation.",
    );
  }
  const id = `job:${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const result = {
    id,
    organisationId: normalized.organisationId,
    reference: normalized.reference,
    status: "DRAFT" as const,
    replayed: false,
  };
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO jobs (
            id, organisation_id, customer_id, reference, title, description,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)`,
        )
        .bind(
          id,
          normalized.organisationId,
          normalized.customerId,
          normalized.reference,
          normalized.title,
          normalized.description ?? null,
          now,
          now,
        ),
      auditStatement(database, {
        id: crypto.randomUUID(),
        organisationId: normalized.organisationId,
        actorType: "USER",
        actorId: normalized.actorId,
        action: "JOB_CREATED",
        aggregateType: "JOB",
        aggregateId: id,
        correlationId: normalized.correlationId,
        causationId: normalized.commandId,
        evidence: {
          customerId: normalized.customerId,
          reference: normalized.reference,
        },
        occurredAt: now,
      }),
      receiptStatement(database, {
        id: normalized.commandId,
        organisationId: normalized.organisationId,
        commandType,
        fingerprint,
        aggregateId: id,
        result,
        now,
      }),
    ]);
  } catch (error) {
    const raced = await receipt(database, command.commandId);
    if (raced) return replay<CreateJobResult>(raced, commandType, fingerprint);
    throw error;
  }
  return result;
}

export async function transitionJob(
  database: D1Database,
  command: TransitionJobCommand,
): Promise<TransitionJobResult> {
  const normalized = {
    ...context(command),
    jobId: required("Job ID", command.jobId),
    action: command.action,
    ...(optional(command.reason) === undefined
      ? {}
      : { reason: optional(command.reason) }),
    occurredAt: timestamp(command.occurredAt),
  };
  if (normalized.action === "CANCEL" && !normalized.reason) {
    throw new TypeError("Job cancellation requires a reason.");
  }
  const commandType = `TRANSITION_JOB_${normalized.action}`;
  const fingerprint = await hashCanonicalJson({ commandType, ...normalized });
  const existing = await receipt(database, command.commandId);
  if (existing)
    return replay<TransitionJobResult>(existing, commandType, fingerprint);
  const job = await database
    .prepare("SELECT status FROM jobs WHERE id = ? AND organisation_id = ?")
    .bind(normalized.jobId, normalized.organisationId)
    .first<JobRow>();
  if (!job) throw new JobCommandUnavailableError("Job was not found.");
  const toStatus = nextStatus(job.status, normalized.action);
  const result = {
    id: normalized.jobId,
    organisationId: normalized.organisationId,
    status: toStatus,
    replayed: false,
  };
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO job_state_transitions (
            id, organisation_id, job_id, from_status, to_status, action,
            actor_id, reason, correlation_id, command_fingerprint, occurred_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          normalized.commandId,
          normalized.organisationId,
          normalized.jobId,
          job.status,
          toStatus,
          normalized.action,
          normalized.actorId,
          normalized.reason ?? null,
          normalized.correlationId,
          fingerprint,
          normalized.occurredAt,
        ),
      database
        .prepare(
          `UPDATE jobs SET status = ?, updated_at = ?, completed_at = ?
           WHERE id = ? AND organisation_id = ? AND status = ?`,
        )
        .bind(
          toStatus,
          normalized.occurredAt,
          toStatus === "COMPLETED" ? normalized.occurredAt : null,
          normalized.jobId,
          normalized.organisationId,
          job.status,
        ),
      auditStatement(database, {
        id: crypto.randomUUID(),
        organisationId: normalized.organisationId,
        actorType: "USER",
        actorId: normalized.actorId,
        action: `JOB_${toStatus}`,
        aggregateType: "JOB",
        aggregateId: normalized.jobId,
        correlationId: normalized.correlationId,
        causationId: normalized.commandId,
        evidence: {
          fromStatus: job.status,
          toStatus,
          reason: normalized.reason ?? null,
        },
        occurredAt: normalized.occurredAt,
      }),
      outboxStatement(database, {
        id: crypto.randomUUID(),
        organisationId: normalized.organisationId,
        messageType: `BUSINESS_JOB_${normalized.action === "START" ? "STARTED" : toStatus}`,
        aggregateType: "JOB",
        aggregateId: normalized.jobId,
        correlationId: normalized.correlationId,
        causationId: normalized.commandId,
        payload: {
          jobId: normalized.jobId,
          fromStatus: job.status,
          toStatus,
          reason: normalized.reason ?? null,
        },
        createdAt: normalized.occurredAt,
      }),
      receiptStatement(database, {
        id: normalized.commandId,
        organisationId: normalized.organisationId,
        commandType,
        fingerprint,
        aggregateId: normalized.jobId,
        result,
        now: normalized.occurredAt,
      }),
    ]);
  } catch (error) {
    const raced = await receipt(database, command.commandId);
    if (raced)
      return replay<TransitionJobResult>(raced, commandType, fingerprint);
    throw error;
  }
  return result;
}

function nextStatus(
  status: JobStatus,
  action: TransitionJobCommand["action"],
): JobStatus {
  if (status === "DRAFT" && action === "START") return "IN_PROGRESS";
  if (status === "IN_PROGRESS" && action === "COMPLETE") return "COMPLETED";
  if ((status === "DRAFT" || status === "IN_PROGRESS") && action === "CANCEL") {
    return "CANCELLED";
  }
  throw new JobCommandUnavailableError(
    `Action ${action} is not allowed from job status ${status}.`,
  );
}

function receiptStatement(
  database: D1Database,
  input: {
    id: string;
    organisationId: string;
    commandType: string;
    fingerprint: string;
    aggregateId: string;
    result: JsonValue;
    now: string;
  },
) {
  return database
    .prepare(
      `INSERT INTO application_command_receipts (
        id, organisation_id, command_type, command_fingerprint,
        aggregate_type, aggregate_id, result_json, completed_at
      ) VALUES (?, ?, ?, ?, 'JOB', ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.organisationId,
      input.commandType,
      input.fingerprint,
      input.aggregateId,
      canonicalJson(input.result),
      input.now,
    );
}

async function receipt(
  database: D1Database,
  id: string,
): Promise<Receipt | null> {
  return database
    .prepare(
      `SELECT command_type, command_fingerprint, result_json
       FROM application_command_receipts WHERE id = ?`,
    )
    .bind(id)
    .first<Receipt>();
}

function replay<T extends Readonly<{ replayed: boolean }>>(
  existing: Receipt,
  type: string,
  fingerprint: string,
): T {
  if (
    existing.command_type !== type ||
    existing.command_fingerprint !== fingerprint
  ) {
    throw new BusinessCommandConflictError(
      "The command identity was already used for different job data.",
    );
  }
  const result = JSON.parse(existing.result_json) as T;
  return { ...result, replayed: true };
}

function context(command: Context): Context {
  return {
    commandId: required("Command ID", command.commandId),
    organisationId: required("Organisation ID", command.organisationId),
    actorId: required("Actor ID", command.actorId),
    correlationId: required("Correlation ID", command.correlationId),
  };
}

function required(label: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} is required.`);
  if (normalized.length > 160) throw new TypeError(`${label} is too long.`);
  return normalized;
}

function optional(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized ? required("Optional text", normalized) : undefined;
}

function timestamp(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(
      "Job transition time must be an ISO 8601 UTC timestamp.",
    );
  }
  return value;
}
