CREATE TABLE settlement_provider_sources (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  network TEXT NOT NULL CHECK (length(trim(network)) > 0),
  source_reference TEXT NOT NULL CHECK (length(trim(source_reference)) > 0),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organisation_id, provider, network)
);

CREATE TABLE participant_settlement_destinations (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  network TEXT NOT NULL CHECK (length(trim(network)) > 0),
  address TEXT NOT NULL CHECK (length(trim(address)) > 0),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organisation_id, participant_id, provider, network)
);

CREATE TRIGGER participant_destinations_tenant_scope_insert
BEFORE INSERT ON participant_settlement_destinations
WHEN NOT EXISTS (
  SELECT 1 FROM participants
  WHERE id = NEW.participant_id
    AND organisation_id = NEW.organisation_id
)
BEGIN
  SELECT RAISE(ABORT, 'settlement destination must share its organisation');
END;

CREATE TRIGGER participant_destinations_tenant_scope_update
BEFORE UPDATE OF organisation_id, participant_id
ON participant_settlement_destinations
WHEN NOT EXISTS (
  SELECT 1 FROM participants
  WHERE id = NEW.participant_id
    AND organisation_id = NEW.organisation_id
)
BEGIN
  SELECT RAISE(ABORT, 'settlement destination must share its organisation');
END;

ALTER TABLE settlement_work_items
ADD COLUMN processing_started_at TEXT;

ALTER TABLE settlement_work_items
ADD COLUMN completed_at TEXT;

ALTER TABLE settlement_work_items
ADD COLUMN next_attempt_at TEXT;

ALTER TABLE settlement_work_items
ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0
CHECK (attempt_count >= 0);

ALTER TABLE settlement_work_items
ADD COLUMN last_error TEXT;

CREATE INDEX idx_settlement_work_items_recovery
  ON settlement_work_items (status, next_attempt_at, processing_started_at);
