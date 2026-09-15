import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const now = "2026-09-14T12:00:00.000Z";

async function seedRule(suffix: string): Promise<{
  eventId: string;
  organisationId: string;
  ruleVersionId: string;
}> {
  const organisationId = `org-${suffix}`;
  const ruleId = `rule-${suffix}`;
  const ruleVersionId = `rule-version-${suffix}`;
  const eventId = `event-${suffix}`;

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organisations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(organisationId, `Organisation ${suffix}`, now, now),
    env.DB.prepare(
      "INSERT INTO settlement_rules (id, organisation_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(ruleId, organisationId, `Rule ${suffix}`, "ACTIVE", now, now),
    env.DB.prepare(
      `INSERT INTO settlement_rule_versions (
        id, rule_id, version, trigger_event_type, trigger_schema_version,
        priority, effective_from, conditions_json, beneficiaries_json,
        provider_policy_json, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      ruleVersionId,
      ruleId,
      1,
      "PAYMENT_CONFIRMED",
      1,
      100,
      now,
      "[]",
      "[]",
      "{}",
      "user-1",
      now,
    ),
    env.DB.prepare(
      `INSERT INTO business_events (
        id, organisation_id, source, external_event_id, event_type,
        schema_version, aggregate_type, aggregate_id, occurred_at,
        recorded_at, correlation_id, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      eventId,
      organisationId,
      "test",
      eventId,
      "PAYMENT_CONFIRMED",
      1,
      "PAYMENT",
      `payment-${suffix}`,
      now,
      now,
      `correlation-${suffix}`,
      "{}",
    ),
  ]);

  return { eventId, organisationId, ruleVersionId };
}

describe("FlowPay foundation migration", () => {
  it("creates the financial and messaging tables", async () => {
    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();

    expect(rows.results.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "business_events",
        "rule_evaluations",
        "settlements",
        "settlement_distributions",
        "settlement_attempts",
        "settlement_provider_transactions",
        "settlement_state_transitions",
        "journal_entries",
        "journal_lines",
        "reconciliation_records",
        "audit_events",
        "outbox_messages",
        "inbox_messages",
        "escrow_arrangements",
        "escrow_milestones",
        "escrow_milestone_verifications",
        "escrow_milestone_releases",
        "escrow_state_transitions",
      ]),
    );
  });

  it("requires allowed, append-only escrow state transitions", async () => {
    const organisationId = "org-escrow-state";
    const escrowId = "escrow-state";
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organisations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      ).bind(organisationId, "Escrow organisation", now, now),
      env.DB.prepare(
        `INSERT INTO escrow_arrangements (
          id, organisation_id, name, asset_code, amount_atomic, asset_scale,
          state, created_by, created_at, updated_at
        ) VALUES (?, ?, 'Contract milestones', 'USD', '200000', 2,
                  'DRAFT', 'user-1', ?, ?)`,
      ).bind(escrowId, organisationId, now, now),
    ]);
    await expect(
      env.DB.prepare(
        "UPDATE escrow_arrangements SET state = 'RELEASED', state_version = 1 WHERE id = ?",
      )
        .bind(escrowId)
        .run(),
    ).rejects.toThrow(/transition must be recorded and allowed/);

    const transitionId = "escrow-transition-activate";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO escrow_state_transitions (
          id, organisation_id, escrow_arrangement_id, from_state, to_state,
          from_version, to_version, action, actor_type, actor_id,
          correlation_id, occurred_at
        ) VALUES (?, ?, ?, 'DRAFT', 'AWAITING_FUNDING', 0, 1,
                  'ACTIVATE', 'USER', 'user-1', 'correlation-escrow', ?)`,
      ).bind(transitionId, organisationId, escrowId, now),
      env.DB.prepare(
        `UPDATE escrow_arrangements
         SET state = 'AWAITING_FUNDING', state_version = 1, updated_at = ?
         WHERE id = ? AND state = 'DRAFT' AND state_version = 0`,
      ).bind(now, escrowId),
    ]);
    await expect(
      env.DB.prepare(
        "UPDATE escrow_state_transitions SET reason = 'changed' WHERE id = ?",
      )
        .bind(transitionId)
        .run(),
    ).rejects.toThrow(/append-only/);
  });

  it("keeps rule evaluation evidence append-only", async () => {
    const { eventId, organisationId } = await seedRule("evaluation-evidence");
    const evaluationId = "evaluation-immutable";
    await env.DB.prepare(
      `INSERT INTO rule_evaluations (
        id, organisation_id, business_event_id, outcome, evidence_json,
        evaluated_at
      ) VALUES (?, ?, ?, 'NO_MATCH', '{}', ?)`,
    )
      .bind(evaluationId, organisationId, eventId, now)
      .run();

    await expect(
      env.DB.prepare(
        "UPDATE rule_evaluations SET evidence_json = '{\"changed\":true}' WHERE id = ?",
      )
        .bind(evaluationId)
        .run(),
    ).rejects.toThrow(/rule evaluations are append-only/);
    await expect(
      env.DB.prepare("DELETE FROM rule_evaluations WHERE id = ?")
        .bind(evaluationId)
        .run(),
    ).rejects.toThrow(/rule evaluations are append-only/);
  });

  it("deduplicates business events at the database boundary", async () => {
    await env.DB.prepare(
      "INSERT INTO organisations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    )
      .bind("org-events", "Events org", now, now)
      .run();

    const insert = () =>
      env.DB.prepare(
        `INSERT INTO business_events (
          id, organisation_id, source, external_event_id, event_type,
          schema_version, aggregate_type, aggregate_id, occurred_at,
          recorded_at, correlation_id, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        "org-events",
        "workshop-demo",
        "payment-42-confirmed",
        "PAYMENT_CONFIRMED",
        1,
        "PAYMENT",
        "payment-42",
        now,
        now,
        "correlation-42",
        "{}",
      );

    await insert().run();
    await expect(insert().run()).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("enforces canonical exact monetary strings", async () => {
    const { eventId, organisationId, ruleVersionId } = await seedRule("money");

    const settlement = (amountAtomic: string) =>
      env.DB.prepare(
        `INSERT INTO settlements (
          id, organisation_id, source_event_id, rule_version_id, asset_code,
          amount_atomic, asset_scale, state, evaluation_evidence_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        organisationId,
        eventId,
        ruleVersionId,
        "USD",
        amountAtomic,
        2,
        "DRAFT",
        "{}",
        now,
        now,
      );

    await expect(settlement("01").run()).rejects.toThrow(
      /CHECK constraint failed/,
    );
    await expect(settlement("10.00").run()).rejects.toThrow(
      /CHECK constraint failed/,
    );
    await expect(settlement("-1").run()).rejects.toThrow(
      /CHECK constraint failed/,
    );
    await expect(settlement("1000").run()).resolves.toBeDefined();
  });

  it("rejects cross-organisation financial references", async () => {
    const first = await seedRule("tenant-first");
    const second = await seedRule("tenant-second");

    await expect(
      env.DB.prepare(
        `INSERT INTO settlements (
          id, organisation_id, source_event_id, rule_version_id, asset_code,
          amount_atomic, asset_scale, state, evaluation_evidence_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'USD', '1000', 2, 'DRAFT', '{}', ?, ?)`,
      )
        .bind(
          "settlement-cross-tenant",
          first.organisationId,
          first.eventId,
          second.ruleVersionId,
          now,
          now,
        )
        .run(),
    ).rejects.toThrow(/must share an organisation/);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO participants (
          id, organisation_id, display_name, participant_type, status,
          created_at, updated_at
        ) VALUES ('participant-second', ?, 'Other tenant', 'CONTRACTOR',
                  'ACTIVE', ?, ?)`,
      ).bind(second.organisationId, now, now),
      env.DB.prepare(
        `INSERT INTO settlements (
          id, organisation_id, source_event_id, rule_version_id, asset_code,
          amount_atomic, asset_scale, state, evaluation_evidence_json,
          created_at, updated_at
        ) VALUES ('settlement-first', ?, ?, ?, 'USD', '1000', 2, 'DRAFT',
                  '{}', ?, ?)`,
      ).bind(
        first.organisationId,
        first.eventId,
        first.ruleVersionId,
        now,
        now,
      ),
    ]);

    await expect(
      env.DB.prepare(
        `INSERT INTO settlement_distributions (
          id, settlement_id, beneficiary_id, position, calculation_kind,
          calculation_json, asset_code, amount_atomic, asset_scale, state,
          created_at, updated_at
        ) VALUES ('distribution-cross-tenant', 'settlement-first',
                  'participant-second', 0, 'FIXED', '{}', 'USD', '1000', 2,
                  'PENDING', ?, ?)`,
      )
        .bind(now, now)
        .run(),
    ).rejects.toThrow(/beneficiary must be active/);
  });

  it("prevents mutation and deletion of immutable financial evidence", async () => {
    const { ruleVersionId } = await seedRule("immutability");

    await expect(
      env.DB.prepare(
        "UPDATE settlement_rule_versions SET priority = 101 WHERE id = ?",
      )
        .bind(ruleVersionId)
        .run(),
    ).rejects.toThrow(/settlement rule versions are immutable/);

    await expect(
      env.DB.prepare("DELETE FROM settlement_rule_versions WHERE id = ?")
        .bind(ruleVersionId)
        .run(),
    ).rejects.toThrow(/settlement rule versions are immutable/);
  });
});
