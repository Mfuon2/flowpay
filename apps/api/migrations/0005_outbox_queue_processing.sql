CREATE TABLE settlement_work_items (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  source_message_id TEXT NOT NULL UNIQUE,
  settlement_id TEXT NOT NULL REFERENCES settlements(id),
  work_type TEXT NOT NULL CHECK (work_type = 'EXECUTE_SETTLEMENT'),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_settlement_work_items_pending
  ON settlement_work_items (status, created_at);

CREATE TRIGGER settlement_work_items_tenant_scope_insert
BEFORE INSERT ON settlement_work_items
WHEN NOT EXISTS (
  SELECT 1 FROM settlements
  WHERE id = NEW.settlement_id
    AND organisation_id = NEW.organisation_id
)
BEGIN
  SELECT RAISE(ABORT, 'settlement work item must share its organisation');
END;

CREATE TABLE queue_message_failures (
  id TEXT PRIMARY KEY,
  queue_name TEXT NOT NULL,
  queue_message_id TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  error_code TEXT NOT NULL,
  error_message TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (queue_name, queue_message_id)
);

CREATE TRIGGER queue_message_failures_no_update
BEFORE UPDATE ON queue_message_failures
BEGIN
  SELECT RAISE(ABORT, 'queue message failures are append-only');
END;

CREATE TRIGGER queue_message_failures_no_delete
BEFORE DELETE ON queue_message_failures
BEGIN
  SELECT RAISE(ABORT, 'queue message failures are append-only');
END;
