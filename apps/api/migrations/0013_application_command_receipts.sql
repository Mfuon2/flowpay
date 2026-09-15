CREATE TABLE application_command_receipts (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  command_type TEXT NOT NULL CHECK (length(trim(command_type)) > 0),
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64
    AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  aggregate_type TEXT NOT NULL CHECK (length(trim(aggregate_type)) > 0),
  aggregate_id TEXT NOT NULL CHECK (length(trim(aggregate_id)) > 0),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  completed_at TEXT NOT NULL,
  UNIQUE (organisation_id, command_type, aggregate_id)
);

CREATE TRIGGER application_command_receipts_no_update
BEFORE UPDATE ON application_command_receipts
BEGIN
  SELECT RAISE(ABORT, 'application command receipts are append-only');
END;

CREATE TRIGGER application_command_receipts_no_delete
BEFORE DELETE ON application_command_receipts
BEGIN
  SELECT RAISE(ABORT, 'application command receipts are append-only');
END;
