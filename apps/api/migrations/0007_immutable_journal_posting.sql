ALTER TABLE journal_entries
ADD COLUMN posting_fingerprint TEXT NOT NULL DEFAULT ''
CHECK (
  posting_fingerprint = ''
  OR (
    length(posting_fingerprint) = 64
    AND posting_fingerprint NOT GLOB '*[^0-9a-f]*'
  )
);

ALTER TABLE journal_entries
ADD COLUMN correlation_id TEXT NOT NULL DEFAULT '';

CREATE TRIGGER journal_entries_insert_as_draft
BEFORE INSERT ON journal_entries
WHEN NEW.status <> 'DRAFT' OR NEW.posted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'journal entries must be created as drafts');
END;

CREATE TRIGGER journal_entries_status_guard
BEFORE UPDATE ON journal_entries
WHEN NOT (
  OLD.status = 'DRAFT'
  AND NEW.status = 'POSTED'
  AND NEW.id = OLD.id
  AND NEW.organisation_id = OLD.organisation_id
  AND NEW.source_type = OLD.source_type
  AND NEW.source_id = OLD.source_id
  AND NEW.posting_purpose = OLD.posting_purpose
  AND NEW.posting_policy_version = OLD.posting_policy_version
  AND NEW.effective_at = OLD.effective_at
  AND NEW.reversal_of_id IS OLD.reversal_of_id
  AND NEW.created_at = OLD.created_at
  AND NEW.posting_fingerprint = OLD.posting_fingerprint
  AND NEW.correlation_id = OLD.correlation_id
  AND NEW.posted_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'posted journal history is immutable');
END;

CREATE TRIGGER journal_entries_no_delete
BEFORE DELETE ON journal_entries
BEGIN
  SELECT RAISE(ABORT, 'journal entries cannot be deleted');
END;

CREATE TRIGGER journal_lines_insert_draft_only
BEFORE INSERT ON journal_lines
WHEN NOT EXISTS (
  SELECT 1 FROM journal_entries
  WHERE id = NEW.journal_entry_id AND status = 'DRAFT'
)
BEGIN
  SELECT RAISE(ABORT, 'journal lines require a draft journal');
END;

CREATE TRIGGER journal_lines_tenant_account_guard
BEFORE INSERT ON journal_lines
WHEN NOT EXISTS (
  SELECT 1
  FROM journal_entries je
  JOIN ledger_accounts la ON la.id = NEW.ledger_account_id
  WHERE je.id = NEW.journal_entry_id
    AND la.organisation_id = je.organisation_id
    AND la.status = 'ACTIVE'
    AND la.asset_code = NEW.asset_code
    AND la.asset_scale = NEW.asset_scale
)
BEGIN
  SELECT RAISE(ABORT, 'journal account must be active and match tenant and asset');
END;

CREATE TRIGGER journal_lines_no_update
BEFORE UPDATE ON journal_lines
BEGIN
  SELECT RAISE(ABORT, 'journal lines are immutable');
END;

CREATE TRIGGER journal_lines_no_delete
BEFORE DELETE ON journal_lines
BEGIN
  SELECT RAISE(ABORT, 'journal lines cannot be deleted');
END;
