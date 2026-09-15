CREATE TABLE accounting_posting_policies (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organisation_id, name)
);

CREATE TABLE accounting_posting_policy_versions (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES accounting_posting_policies(id),
  version INTEGER NOT NULL CHECK (version > 0),
  trigger_event_type TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  UNIQUE (policy_id, version)
);

CREATE TABLE accounting_work_items (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  source_message_id TEXT NOT NULL UNIQUE,
  settlement_id TEXT NOT NULL UNIQUE REFERENCES settlements(id),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  posting_policy_version_id TEXT REFERENCES accounting_posting_policy_versions(id),
  journal_entry_id TEXT REFERENCES journal_entries(id),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_accounting_work_items_pending
  ON accounting_work_items (status, created_at);

CREATE TRIGGER accounting_policy_versions_no_update
BEFORE UPDATE ON accounting_posting_policy_versions
BEGIN
  SELECT RAISE(ABORT, 'accounting posting policy versions are immutable');
END;

CREATE TRIGGER accounting_policy_versions_no_delete
BEFORE DELETE ON accounting_posting_policy_versions
BEGIN
  SELECT RAISE(ABORT, 'accounting posting policy versions are immutable');
END;

CREATE TRIGGER accounting_work_items_tenant_scope_insert
BEFORE INSERT ON accounting_work_items
WHEN NOT EXISTS (
  SELECT 1 FROM settlements
  WHERE id = NEW.settlement_id
    AND organisation_id = NEW.organisation_id
)
BEGIN
  SELECT RAISE(ABORT, 'accounting work item must share its organisation');
END;
