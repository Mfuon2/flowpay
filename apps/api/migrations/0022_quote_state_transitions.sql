CREATE TABLE quote_state_transitions (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  quote_id TEXT NOT NULL REFERENCES quotes(id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('ISSUE', 'APPROVE', 'REJECT', 'EXPIRE')),
  actor_id TEXT NOT NULL,
  reason TEXT,
  correlation_id TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64
    AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  occurred_at TEXT NOT NULL,
  UNIQUE (quote_id, to_status)
);

CREATE TRIGGER quote_state_transitions_scope
BEFORE INSERT ON quote_state_transitions
WHEN NOT EXISTS (
  SELECT 1 FROM quotes
  WHERE id = NEW.quote_id AND organisation_id = NEW.organisation_id
    AND status = NEW.from_status
)
BEGIN
  SELECT RAISE(ABORT, 'stale or cross-organisation quote transition');
END;

CREATE TRIGGER quote_state_transitions_allowed
BEFORE INSERT ON quote_state_transitions
WHEN NOT (
  (NEW.from_status = 'DRAFT' AND NEW.to_status = 'ISSUED' AND NEW.action = 'ISSUE')
  OR (NEW.from_status = 'ISSUED' AND NEW.to_status = 'APPROVED' AND NEW.action = 'APPROVE')
  OR (NEW.from_status = 'ISSUED' AND NEW.to_status = 'REJECTED' AND NEW.action = 'REJECT')
  OR (NEW.from_status = 'ISSUED' AND NEW.to_status = 'EXPIRED' AND NEW.action = 'EXPIRE')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid quote state transition');
END;

CREATE TRIGGER quotes_status_transition_guard
BEFORE UPDATE OF status ON quotes
WHEN NEW.status <> OLD.status AND NOT EXISTS (
  SELECT 1 FROM quote_state_transitions
  WHERE quote_id = OLD.id AND from_status = OLD.status AND to_status = NEW.status
)
BEGIN
  SELECT RAISE(ABORT, 'quote status transition must be recorded');
END;

CREATE TRIGGER quotes_financial_terms_immutable
BEFORE UPDATE OF organisation_id, customer_id, job_id, reference,
  asset_code, total_atomic, asset_scale ON quotes
BEGIN
  SELECT RAISE(ABORT, 'quote financial terms are immutable');
END;

CREATE TRIGGER quote_lines_no_update
BEFORE UPDATE ON quote_lines
BEGIN
  SELECT RAISE(ABORT, 'quote lines are immutable');
END;

CREATE TRIGGER quote_lines_no_delete
BEFORE DELETE ON quote_lines
BEGIN
  SELECT RAISE(ABORT, 'quote lines are immutable');
END;

CREATE TRIGGER quote_state_transitions_no_update
BEFORE UPDATE ON quote_state_transitions
BEGIN
  SELECT RAISE(ABORT, 'quote transitions are append-only');
END;

CREATE TRIGGER quote_state_transitions_no_delete
BEFORE DELETE ON quote_state_transitions
BEGIN
  SELECT RAISE(ABORT, 'quote transitions are append-only');
END;
