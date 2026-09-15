CREATE TABLE approval_policy_status_transitions (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  policy_id TEXT NOT NULL REFERENCES approval_policies(id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('ACTIVATE', 'DEACTIVATE')),
  actor_id TEXT NOT NULL,
  reason TEXT,
  correlation_id TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL CHECK (length(command_fingerprint) = 64),
  occurred_at TEXT NOT NULL,
  UNIQUE (policy_id, from_status, to_status)
);

CREATE TABLE settlement_rule_status_transitions (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  rule_id TEXT NOT NULL REFERENCES settlement_rules(id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('ACTIVATE', 'DEACTIVATE')),
  actor_id TEXT NOT NULL,
  reason TEXT,
  correlation_id TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL CHECK (length(command_fingerprint) = 64),
  occurred_at TEXT NOT NULL,
  UNIQUE (rule_id, from_status, to_status)
);

CREATE TRIGGER approval_policy_status_transition_scope
BEFORE INSERT ON approval_policy_status_transitions
WHEN NOT EXISTS (
  SELECT 1 FROM approval_policies
  WHERE id = NEW.policy_id AND organisation_id = NEW.organisation_id
    AND status = NEW.from_status
)
BEGIN
  SELECT RAISE(ABORT, 'stale or cross-organisation approval policy transition');
END;

CREATE TRIGGER settlement_rule_status_transition_scope
BEFORE INSERT ON settlement_rule_status_transitions
WHEN NOT EXISTS (
  SELECT 1 FROM settlement_rules
  WHERE id = NEW.rule_id AND organisation_id = NEW.organisation_id
    AND status = NEW.from_status
)
BEGIN
  SELECT RAISE(ABORT, 'stale or cross-organisation settlement rule transition');
END;

CREATE TRIGGER approval_policy_status_transition_allowed
BEFORE INSERT ON approval_policy_status_transitions
WHEN NOT (
  (NEW.from_status = 'DRAFT' AND NEW.to_status = 'ACTIVE' AND NEW.action = 'ACTIVATE')
  OR (NEW.from_status = 'ACTIVE' AND NEW.to_status = 'INACTIVE' AND NEW.action = 'DEACTIVATE')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid approval policy status transition');
END;

CREATE TRIGGER settlement_rule_status_transition_allowed
BEFORE INSERT ON settlement_rule_status_transitions
WHEN NOT (
  (NEW.from_status = 'DRAFT' AND NEW.to_status = 'ACTIVE' AND NEW.action = 'ACTIVATE')
  OR (NEW.from_status = 'ACTIVE' AND NEW.to_status = 'INACTIVE' AND NEW.action = 'DEACTIVATE')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid settlement rule status transition');
END;

CREATE TRIGGER approval_policies_status_guard
BEFORE UPDATE OF status ON approval_policies
WHEN NEW.status <> OLD.status AND NOT EXISTS (
  SELECT 1 FROM approval_policy_status_transitions
  WHERE policy_id = OLD.id AND from_status = OLD.status AND to_status = NEW.status
)
BEGIN
  SELECT RAISE(ABORT, 'approval policy status transition must be recorded');
END;

CREATE TRIGGER settlement_rules_status_guard
BEFORE UPDATE OF status ON settlement_rules
WHEN NEW.status <> OLD.status AND NOT EXISTS (
  SELECT 1 FROM settlement_rule_status_transitions
  WHERE rule_id = OLD.id AND from_status = OLD.status AND to_status = NEW.status
)
BEGIN
  SELECT RAISE(ABORT, 'settlement rule status transition must be recorded');
END;

CREATE TRIGGER approval_policy_status_transitions_no_update
BEFORE UPDATE ON approval_policy_status_transitions
BEGIN SELECT RAISE(ABORT, 'approval policy transitions are append-only'); END;

CREATE TRIGGER approval_policy_status_transitions_no_delete
BEFORE DELETE ON approval_policy_status_transitions
BEGIN SELECT RAISE(ABORT, 'approval policy transitions are append-only'); END;

CREATE TRIGGER settlement_rule_status_transitions_no_update
BEFORE UPDATE ON settlement_rule_status_transitions
BEGIN SELECT RAISE(ABORT, 'settlement rule transitions are append-only'); END;

CREATE TRIGGER settlement_rule_status_transitions_no_delete
BEFORE DELETE ON settlement_rule_status_transitions
BEGIN SELECT RAISE(ABORT, 'settlement rule transitions are append-only'); END;
