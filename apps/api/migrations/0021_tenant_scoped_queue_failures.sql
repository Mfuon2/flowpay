ALTER TABLE queue_message_failures
ADD COLUMN organisation_id TEXT REFERENCES organisations(id);

CREATE INDEX idx_queue_message_failures_organisation
  ON queue_message_failures (organisation_id, recorded_at);
