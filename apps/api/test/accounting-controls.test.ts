import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { postJournal } from "../src/accounting/post-journal.ts";
import { resolveReconciliation } from "../src/accounting/resolve-reconciliation.ts";
import { reverseJournal } from "../src/accounting/reverse-journal.ts";
import type { AuthenticatedPrincipal } from "../src/auth/access-auth.ts";
import { handleApiRequest } from "../src/http/api.ts";

const now = "2026-09-14T12:00:00Z";

describe("accounting correction controls", () => {
  it("posts one exact inverse journal without editing the original", async () => {
    const setup = await seedJournalSource("reversal");
    const original = await postJournal(env.DB, {
      postingId: "journal-original-reversal",
      organisationId: setup.organisationId,
      sourceType: "BUSINESS_EVENT",
      sourceId: setup.eventId,
      postingPurpose: "PAYMENT_RECEIPT",
      postingPolicyVersion: "receipt-v1",
      effectiveAt: now,
      correlationId: "correlation-reversal",
      actorId: "accounting-service",
      lines: [
        {
          accountId: setup.cashAccountId,
          direction: "DEBIT",
          amount: { assetCode: "USD", atomicAmount: "100000", scale: 2 },
        },
        {
          accountId: setup.receivableAccountId,
          direction: "CREDIT",
          amount: { assetCode: "USD", atomicAmount: "100000", scale: 2 },
        },
      ],
    });
    const command = {
      reversalId: "journal-reversal",
      organisationId: setup.organisationId,
      journalEntryId: original.journalEntryId,
      actorId: "finance-reviewer",
      correlationId: "correlation-reversal",
      reason: "Receipt was recorded against the wrong invoice.",
      evidenceReference: "CASE-REVERSAL-001",
      effectiveAt: now,
    } as const;
    await expect(reverseJournal(env.DB, command)).resolves.toMatchObject({
      reversalJournalEntryId: "journal-reversal",
      originalJournalEntryId: original.journalEntryId,
      replayed: false,
    });
    await expect(reverseJournal(env.DB, command)).resolves.toMatchObject({
      reversalJournalEntryId: "journal-reversal",
      replayed: true,
    });
    const entries = await env.DB.prepare(
      `SELECT id, status, reversal_of_id FROM journal_entries
       WHERE id IN (?, ?) ORDER BY id`,
    )
      .bind(original.journalEntryId, command.reversalId)
      .all<{
        id: string;
        status: string;
        reversal_of_id: string | null;
      }>();
    expect(entries.results).toEqual([
      {
        id: original.journalEntryId,
        status: "POSTED",
        reversal_of_id: null,
      },
      {
        id: command.reversalId,
        status: "POSTED",
        reversal_of_id: original.journalEntryId,
      },
    ]);
    const directions = await env.DB.prepare(
      `SELECT direction FROM journal_lines
       WHERE journal_entry_id = ? ORDER BY position`,
    )
      .bind(command.reversalId)
      .all<{ direction: string }>();
    expect(directions.results.map(({ direction }) => direction)).toEqual([
      "CREDIT",
      "DEBIT",
    ]);
    await expect(
      reverseJournal(env.DB, { ...command, reason: "Different evidence" }),
    ).rejects.toThrow(/different financial data/);
    await expect(
      env.DB.prepare(
        "UPDATE journal_lines SET amount_atomic = '1' WHERE journal_entry_id = ?",
      )
        .bind(original.journalEntryId)
        .run(),
    ).rejects.toThrow(/immutable/);
  });

  it("resolves a mismatch once with append-only finance evidence", async () => {
    const setup = await seedReconciliation("resolution");
    await expect(
      env.DB.prepare(
        "UPDATE reconciliation_records SET status = 'RESOLVED' WHERE id = ?",
      )
        .bind(setup.reconciliationId)
        .run(),
    ).rejects.toThrow(/except by resolution/);
    const command = {
      resolutionId: "resolution-accounting-control",
      organisationId: setup.organisationId,
      reconciliationId: setup.reconciliationId,
      actorId: "finance-reviewer",
      correlationId: "correlation-resolution",
      reason: "Provider evidence was independently verified.",
      evidenceReference: "CASE-RECON-001",
      resolvedAt: now,
    } as const;
    await expect(resolveReconciliation(env.DB, command)).resolves.toEqual({
      reconciliationId: setup.reconciliationId,
      resolutionId: command.resolutionId,
      status: "RESOLVED",
      replayed: false,
    });
    await expect(resolveReconciliation(env.DB, command)).resolves.toMatchObject(
      { replayed: true },
    );
    await expect(
      resolveReconciliation(env.DB, {
        ...command,
        evidenceReference: "CHANGED",
      }),
    ).rejects.toThrow(/different evidence/);
    await expect(
      env.DB.prepare(
        "UPDATE reconciliation_resolutions SET reason = 'changed' WHERE id = ?",
      )
        .bind(command.resolutionId)
        .run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare("DELETE FROM reconciliation_resolutions WHERE id = ?")
        .bind(command.resolutionId)
        .run(),
    ).rejects.toThrow(/append-only/);
  });

  it("exposes corrections only through authenticated finance commands", async () => {
    const setup = await seedReconciliation("api-resolution");
    const request = () =>
      new Request(
        `https://flowpay.test/api/v1/reconciliations/${encodeURIComponent(setup.reconciliationId)}/resolutions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "api-resolution-control",
          },
          body: JSON.stringify({
            reason: "Reviewed against provider evidence.",
            evidenceReference: "CASE-API-RECON-001",
            resolvedAt: now,
          }),
        },
      );
    const operations = testPrincipal(setup.organisationId, ["OPERATIONS"]);
    const forbidden = await handleApiRequest(request(), env, () =>
      Promise.resolve(operations),
    );
    expect(forbidden?.status).toBe(403);
    const finance = testPrincipal(setup.organisationId, ["FINANCE"]);
    const resolved = await handleApiRequest(request(), env, () =>
      Promise.resolve(finance),
    );
    expect(resolved?.status).toBe(201);
    await expect(resolved?.json()).resolves.toMatchObject({
      status: "RESOLVED",
      replayed: false,
    });
    const replayed = await handleApiRequest(request(), env, () =>
      Promise.resolve(finance),
    );
    expect(replayed?.status).toBe(200);
  });
});

function testPrincipal(
  organisationId: string,
  roles: AuthenticatedPrincipal["roles"],
): AuthenticatedPrincipal {
  return {
    userId: "accounting-control-user",
    subject: "accounting-control-user",
    email: "accounting-control@example.com",
    organisationId,
    membershipId: "accounting-control-membership",
    roles,
  };
}

async function seedJournalSource(suffix: string) {
  const organisationId = `org-accounting-${suffix}`;
  const eventId = `event-accounting-${suffix}`;
  const cashAccountId = `cash-account-${suffix}`;
  const receivableAccountId = `receivable-account-${suffix}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organisations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(organisationId, organisationId, now, now),
    env.DB.prepare(
      `INSERT INTO business_events (
        id, organisation_id, source, external_event_id, event_type,
        schema_version, aggregate_type, aggregate_id, occurred_at, recorded_at,
        correlation_id, payload_json
      ) VALUES (?, ?, 'test', ?, 'PAYMENT_CONFIRMED', 1, 'PAYMENT', ?, ?, ?, ?, '{}')`,
    ).bind(eventId, organisationId, eventId, eventId, now, now, eventId),
    ledgerAccount(cashAccountId, organisationId, "1000", "Digital Cash"),
    ledgerAccount(
      receivableAccountId,
      organisationId,
      "1100",
      "Customer Receivable",
    ),
  ]);
  return { organisationId, eventId, cashAccountId, receivableAccountId };
}

async function seedReconciliation(suffix: string) {
  const organisationId = `org-reconciliation-${suffix}`;
  const eventId = `event-reconciliation-${suffix}`;
  const ruleId = `rule-reconciliation-${suffix}`;
  const ruleVersionId = `rule-version-reconciliation-${suffix}`;
  const participantId = `participant-reconciliation-${suffix}`;
  const settlementId = `settlement-reconciliation-${suffix}`;
  const distributionId = `distribution-reconciliation-${suffix}`;
  const reconciliationId = `reconciliation-${suffix}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organisations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(organisationId, organisationId, now, now),
    env.DB.prepare(
      `INSERT INTO participants (
        id, organisation_id, display_name, participant_type, status,
        created_at, updated_at
      ) VALUES (?, ?, 'Beneficiary', 'CONTRACTOR', 'ACTIVE', ?, ?)`,
    ).bind(participantId, organisationId, now, now),
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
      ) VALUES (?, ?, 1, 'TEST', 1, 1, ?, '[]', '[]', '{}', 'test', ?)`,
    ).bind(ruleVersionId, ruleId, now, now),
    env.DB.prepare(
      `INSERT INTO business_events (
        id, organisation_id, source, external_event_id, event_type,
        schema_version, aggregate_type, aggregate_id, occurred_at, recorded_at,
        correlation_id, payload_json
      ) VALUES (?, ?, 'test', ?, 'TEST', 1, 'TEST', ?, ?, ?, ?, '{}')`,
    ).bind(eventId, organisationId, eventId, eventId, now, now, eventId),
    env.DB.prepare(
      `INSERT INTO settlements (
        id, organisation_id, source_event_id, rule_version_id, asset_code,
        amount_atomic, asset_scale, state, state_version,
        evaluation_evidence_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'USD', '1000', 2, 'CONFIRMED', 0, '{}', ?, ?)`,
    ).bind(settlementId, organisationId, eventId, ruleVersionId, now, now),
    env.DB.prepare(
      `INSERT INTO settlement_distributions (
        id, settlement_id, beneficiary_id, position, calculation_kind,
        calculation_json, asset_code, amount_atomic, asset_scale, state,
        created_at, updated_at
      ) VALUES (?, ?, ?, 0, 'REMAINDER', '{}', 'USD', '1000', 2,
                'CONFIRMED', ?, ?)`,
    ).bind(distributionId, settlementId, participantId, now, now),
    env.DB.prepare(
      `INSERT INTO reconciliation_records (
        id, organisation_id, settlement_distribution_id, status,
        evidence_json, created_at, updated_at, reconciliation_fingerprint,
        checked_at
      ) VALUES (?, ?, ?, 'MISMATCHED', '{}', ?, ?, '', ?)`,
    ).bind(reconciliationId, organisationId, distributionId, now, now, now),
  ]);
  return { organisationId, reconciliationId };
}

function ledgerAccount(
  id: string,
  organisationId: string,
  code: string,
  name: string,
) {
  return env.DB.prepare(
    `INSERT INTO ledger_accounts (
      id, organisation_id, code, name, account_type, asset_code,
      asset_scale, status, created_at
    ) VALUES (?, ?, ?, ?, 'ASSET', 'USD', 2, 'ACTIVE', ?)`,
  ).bind(id, organisationId, code, name, now);
}
