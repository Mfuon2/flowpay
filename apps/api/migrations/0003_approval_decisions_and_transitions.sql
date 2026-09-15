ALTER TABLE settlements
ADD COLUMN initiated_by TEXT NOT NULL DEFAULT '';

ALTER TABLE approval_requests
ADD COLUMN decision_version INTEGER NOT NULL DEFAULT 0
CHECK (decision_version >= 0);

ALTER TABLE approval_decisions
ADD COLUMN actor_roles_json TEXT NOT NULL DEFAULT '[]'
CHECK (json_valid(actor_roles_json));

ALTER TABLE approval_decisions
ADD COLUMN request_version INTEGER NOT NULL DEFAULT 0
CHECK (request_version >= 0);

ALTER TABLE approval_decisions
ADD COLUMN decision_fingerprint TEXT NOT NULL DEFAULT ''
CHECK (
  decision_fingerprint = ''
  OR (
    length(decision_fingerprint) = 64
    AND decision_fingerprint NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE TABLE settlement_state_transitions (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  settlement_id TEXT NOT NULL REFERENCES settlements(id),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  from_version INTEGER NOT NULL CHECK (from_version >= 0),
  to_version INTEGER NOT NULL CHECK (to_version = from_version + 1),
  action TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('USER', 'SERVICE', 'PROVIDER')),
  actor_id TEXT NOT NULL,
  reason TEXT,
  correlation_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (settlement_id, to_version)
);

CREATE INDEX idx_settlement_state_transitions_timeline
  ON settlement_state_transitions (organisation_id, settlement_id, to_version);

CREATE TRIGGER approval_decisions_version_guard
BEFORE INSERT ON approval_decisions
WHEN NOT EXISTS (
  SELECT 1 FROM approval_requests
  WHERE id = NEW.approval_request_id
    AND status = 'PENDING'
    AND decision_version = NEW.request_version
)
BEGIN
  SELECT RAISE(ABORT, 'stale or closed approval request');
END;

CREATE TRIGGER approval_decisions_increment_version
AFTER INSERT ON approval_decisions
BEGIN
  UPDATE approval_requests
  SET decision_version = decision_version + 1
  WHERE id = NEW.approval_request_id;
END;

CREATE TRIGGER approval_requests_status_transition_guard
BEFORE UPDATE OF status ON approval_requests
WHEN NEW.status <> OLD.status
  AND NOT (
    OLD.status = 'PENDING'
    AND NEW.status IN ('APPROVED', 'REJECTED', 'CANCELLED')
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid approval request status transition');
END;

CREATE TRIGGER settlement_state_transitions_match_current
BEFORE INSERT ON settlement_state_transitions
WHEN NOT EXISTS (
  SELECT 1 FROM settlements
  WHERE id = NEW.settlement_id
    AND organisation_id = NEW.organisation_id
    AND state = NEW.from_state
    AND state_version = NEW.from_version
)
BEGIN
  SELECT RAISE(ABORT, 'stale settlement state transition');
END;

CREATE TRIGGER settlements_state_transition_guard
BEFORE UPDATE OF state ON settlements
WHEN NEW.state <> OLD.state
  AND (
    NEW.state_version <> OLD.state_version + 1
    OR NOT (
      (OLD.state = 'DRAFT' AND NEW.state IN ('PENDING_RULE_EVALUATION', 'CANCELLED'))
      OR (OLD.state = 'PENDING_RULE_EVALUATION' AND NEW.state IN ('PENDING_APPROVAL', 'READY', 'FAILED', 'CANCELLED'))
      OR (OLD.state = 'PENDING_APPROVAL' AND NEW.state IN ('READY', 'FAILED', 'CANCELLED'))
      OR (OLD.state = 'READY' AND NEW.state IN ('SUBMITTING', 'CANCELLED'))
      OR (OLD.state = 'SUBMITTING' AND NEW.state IN ('SUBMITTED', 'CONFIRMED', 'FAILED'))
      OR (OLD.state = 'SUBMITTED' AND NEW.state IN ('CONFIRMED', 'FAILED'))
      OR (OLD.state = 'CONFIRMED' AND NEW.state = 'REVERSED')
      OR (OLD.state = 'FAILED' AND NEW.state = 'READY')
    )
    OR NOT EXISTS (
      SELECT 1 FROM settlement_state_transitions transition_record
      WHERE transition_record.settlement_id = OLD.id
        AND transition_record.from_state = OLD.state
        AND transition_record.to_state = NEW.state
        AND transition_record.from_version = OLD.state_version
        AND transition_record.to_version = NEW.state_version
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid or unaudited settlement state transition');
END;

CREATE TRIGGER settlements_state_version_guard
BEFORE UPDATE OF state_version ON settlements
WHEN NEW.state = OLD.state AND NEW.state_version <> OLD.state_version
BEGIN
  SELECT RAISE(ABORT, 'settlement state version requires a state transition');
END;

CREATE TRIGGER settlement_state_transitions_no_update
BEFORE UPDATE ON settlement_state_transitions
BEGIN
  SELECT RAISE(ABORT, 'settlement state transitions are append-only');
END;

CREATE TRIGGER settlement_state_transitions_no_delete
BEFORE DELETE ON settlement_state_transitions
BEGIN
  SELECT RAISE(ABORT, 'settlement state transitions are append-only');
END;
