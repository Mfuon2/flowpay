CREATE TABLE invoice_state_transitions (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('PAYMENT_RECEIVED', 'VOID')),
  actor_id TEXT NOT NULL,
  reason TEXT,
  correlation_id TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64
    AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  occurred_at TEXT NOT NULL,
  UNIQUE (invoice_id, to_status)
);

CREATE TRIGGER invoice_state_transitions_scope
BEFORE INSERT ON invoice_state_transitions
WHEN NOT EXISTS (
  SELECT 1 FROM invoices
  WHERE id = NEW.invoice_id AND organisation_id = NEW.organisation_id
    AND status = NEW.from_status
)
BEGIN
  SELECT RAISE(ABORT, 'stale or cross-organisation invoice transition');
END;

CREATE TRIGGER invoice_state_transitions_allowed
BEFORE INSERT ON invoice_state_transitions
WHEN NOT (
  (NEW.from_status = 'ISSUED' AND NEW.to_status = 'PAID' AND NEW.action = 'PAYMENT_RECEIVED')
  OR (NEW.from_status = 'DRAFT' AND NEW.to_status = 'VOID' AND NEW.action = 'VOID')
  OR (NEW.from_status = 'ISSUED' AND NEW.to_status = 'VOID' AND NEW.action = 'VOID')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid invoice state transition');
END;

CREATE TRIGGER invoices_status_transition_guard
BEFORE UPDATE OF status ON invoices
WHEN NEW.status <> OLD.status AND NOT EXISTS (
  SELECT 1 FROM invoice_state_transitions
  WHERE invoice_id = OLD.id AND from_status = OLD.status AND to_status = NEW.status
)
BEGIN
  SELECT RAISE(ABORT, 'invoice status transition must be recorded');
END;

CREATE TRIGGER payment_confirmation_requires_open_invoice
BEFORE INSERT ON payment_state_transitions
WHEN NEW.from_status = 'PENDING' AND NEW.to_status = 'CONFIRMED'
  AND NOT EXISTS (
    SELECT 1 FROM payments p JOIN invoices i ON i.id = p.invoice_id
    WHERE p.id = NEW.payment_id AND p.organisation_id = NEW.organisation_id
      AND i.organisation_id = NEW.organisation_id AND i.status = 'ISSUED'
  )
BEGIN
  SELECT RAISE(ABORT, 'payment confirmation requires an issued invoice');
END;

CREATE TRIGGER invoice_state_transitions_no_update
BEFORE UPDATE ON invoice_state_transitions
BEGIN SELECT RAISE(ABORT, 'invoice transitions are append-only'); END;

CREATE TRIGGER invoice_state_transitions_no_delete
BEFORE DELETE ON invoice_state_transitions
BEGIN SELECT RAISE(ABORT, 'invoice transitions are append-only'); END;
