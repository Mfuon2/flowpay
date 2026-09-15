CREATE TABLE settlement_recovery_decisions (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  settlement_id TEXT NOT NULL REFERENCES settlements(id),
  settlement_attempt_id TEXT NOT NULL UNIQUE REFERENCES settlement_attempts(id),
  action TEXT NOT NULL CHECK (action = 'RETRY_CONFIRMED_NOT_SUBMITTED'),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  evidence_reference TEXT NOT NULL CHECK (length(trim(evidence_reference)) > 0),
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64
    AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  decided_at TEXT NOT NULL
);

CREATE TRIGGER settlement_recovery_decisions_scope
BEFORE INSERT ON settlement_recovery_decisions
WHEN NOT EXISTS (
  SELECT 1
  FROM settlement_attempts sa
  JOIN settlement_distributions sd ON sd.id = sa.settlement_distribution_id
  JOIN settlements s ON s.id = sd.settlement_id
  JOIN settlement_work_items wi ON wi.settlement_id = s.id
  WHERE sa.id = NEW.settlement_attempt_id
    AND sa.status = 'OUTCOME_UNKNOWN'
    AND sd.state = 'SUBMITTING'
    AND s.id = NEW.settlement_id
    AND s.organisation_id = NEW.organisation_id
    AND s.state = 'SUBMITTING'
    AND wi.status = 'FAILED'
    AND NOT EXISTS (
      SELECT 1 FROM settlement_provider_transactions spt
      WHERE spt.settlement_attempt_id = sa.id
        AND spt.provider_transaction_id IS NOT NULL
    )
)
BEGIN
  SELECT RAISE(ABORT, 'settlement recovery is not available for this attempt');
END;

CREATE TRIGGER settlement_recovery_decisions_no_update
BEFORE UPDATE ON settlement_recovery_decisions
BEGIN
  SELECT RAISE(ABORT, 'settlement recovery decisions are append-only');
END;

CREATE TRIGGER settlement_recovery_decisions_no_delete
BEFORE DELETE ON settlement_recovery_decisions
BEGIN
  SELECT RAISE(ABORT, 'settlement recovery decisions are append-only');
END;
