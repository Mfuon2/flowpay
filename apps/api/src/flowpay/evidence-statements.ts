import type { JsonValue } from "@flowpay/domain";

import { canonicalJson } from "./canonical-json.ts";

export function auditStatement(
  database: D1Database,
  value: Readonly<{
    id: string;
    organisationId: string;
    actorType: "USER" | "SERVICE" | "PROVIDER";
    actorId: string;
    action: string;
    aggregateType: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    evidence: JsonValue;
    occurredAt: string;
  }>,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO audit_events (
        id, organisation_id, actor_type, actor_id, action, aggregate_type,
        aggregate_id, correlation_id, causation_id, evidence_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      value.id,
      value.organisationId,
      value.actorType,
      value.actorId,
      value.action,
      value.aggregateType,
      value.aggregateId,
      value.correlationId,
      value.causationId ?? null,
      canonicalJson(value.evidence),
      value.occurredAt,
    );
}

export function outboxStatement(
  database: D1Database,
  value: Readonly<{
    id: string;
    organisationId: string;
    messageType: string;
    aggregateType: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    payload: JsonValue;
    createdAt: string;
  }>,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_messages (
        id, organisation_id, message_type, schema_version, aggregate_type,
        aggregate_id, correlation_id, causation_id, payload_json, created_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      value.id,
      value.organisationId,
      value.messageType,
      value.aggregateType,
      value.aggregateId,
      value.correlationId,
      value.causationId ?? null,
      canonicalJson(value.payload),
      value.createdAt,
    );
}
