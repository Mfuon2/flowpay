CREATE UNIQUE INDEX journal_entries_one_reversal
  ON journal_entries (reversal_of_id)
  WHERE reversal_of_id IS NOT NULL;

CREATE TABLE reconciliation_resolutions (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  reconciliation_id TEXT NOT NULL UNIQUE REFERENCES reconciliation_records(id),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  evidence_reference TEXT NOT NULL CHECK (length(trim(evidence_reference)) > 0),
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64
    AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  resolved_at TEXT NOT NULL
);

CREATE TRIGGER reconciliation_resolutions_tenant_scope_insert
BEFORE INSERT ON reconciliation_resolutions
WHEN NOT EXISTS (
  SELECT 1 FROM reconciliation_records rr
  WHERE rr.id = NEW.reconciliation_id
    AND rr.organisation_id = NEW.organisation_id
    AND rr.status = 'MISMATCHED'
)
BEGIN
  SELECT RAISE(ABORT, 'only a tenant-scoped mismatch can be resolved');
END;

CREATE TRIGGER reconciliation_resolutions_no_update
BEFORE UPDATE ON reconciliation_resolutions
BEGIN
  SELECT RAISE(ABORT, 'reconciliation resolutions are append-only');
END;

CREATE TRIGGER reconciliation_resolutions_no_delete
BEFORE DELETE ON reconciliation_resolutions
BEGIN
  SELECT RAISE(ABORT, 'reconciliation resolutions are append-only');
END;

CREATE TRIGGER reconciliation_records_resolution_guard
BEFORE UPDATE ON reconciliation_records
WHEN NOT (
  OLD.status = 'MISMATCHED'
  AND NEW.status = 'RESOLVED'
  AND NEW.id = OLD.id
  AND NEW.organisation_id = OLD.organisation_id
  AND NEW.settlement_distribution_id = OLD.settlement_distribution_id
  AND NEW.provider_transaction_id IS OLD.provider_transaction_id
  AND NEW.journal_entry_id IS OLD.journal_entry_id
  AND NEW.evidence_json = OLD.evidence_json
  AND NEW.created_at = OLD.created_at
  AND NEW.journal_line_id IS OLD.journal_line_id
  AND NEW.reconciliation_fingerprint = OLD.reconciliation_fingerprint
  AND NEW.checked_at IS OLD.checked_at
  AND NEW.resolution_json IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM reconciliation_resolutions resolution
    WHERE resolution.reconciliation_id = OLD.id
      AND resolution.organisation_id = OLD.organisation_id
      AND json_extract(NEW.resolution_json, '$.resolutionId') = resolution.id
      AND json_extract(NEW.resolution_json, '$.actorId') = resolution.actor_id
      AND json_extract(NEW.resolution_json, '$.reason') = resolution.reason
      AND json_extract(NEW.resolution_json, '$.evidenceReference') = resolution.evidence_reference
      AND json_extract(NEW.resolution_json, '$.resolvedAt') = resolution.resolved_at
  )
)
BEGIN
  SELECT RAISE(ABORT, 'reconciliation history is immutable except by resolution');
END;
