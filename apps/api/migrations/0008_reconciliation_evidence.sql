ALTER TABLE reconciliation_records
ADD COLUMN journal_line_id TEXT REFERENCES journal_lines(id);

ALTER TABLE reconciliation_records
ADD COLUMN reconciliation_fingerprint TEXT NOT NULL DEFAULT ''
CHECK (
  reconciliation_fingerprint = ''
  OR (
    length(reconciliation_fingerprint) = 64
    AND reconciliation_fingerprint NOT GLOB '*[^0-9a-f]*'
  )
);

ALTER TABLE reconciliation_records
ADD COLUMN checked_at TEXT;

CREATE TRIGGER reconciliation_records_tenant_scope_insert
BEFORE INSERT ON reconciliation_records
WHEN NOT EXISTS (
  SELECT 1
  FROM settlement_distributions sd
  JOIN settlements s ON s.id = sd.settlement_id
  WHERE sd.id = NEW.settlement_distribution_id
    AND s.organisation_id = NEW.organisation_id
)
BEGIN
  SELECT RAISE(ABORT, 'reconciliation must share its organisation');
END;

CREATE TRIGGER reconciliation_records_no_delete
BEFORE DELETE ON reconciliation_records
BEGIN
  SELECT RAISE(ABORT, 'reconciliation records cannot be deleted');
END;
