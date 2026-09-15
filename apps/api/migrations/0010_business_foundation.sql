CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  email TEXT,
  phone TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organisation_id, id)
);

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT,
  unit_price_atomic TEXT NOT NULL CHECK (
    unit_price_atomic GLOB '[0-9]*'
    AND unit_price_atomic NOT GLOB '*[^0-9]*'
    AND (unit_price_atomic = '0' OR substr(unit_price_atomic, 1, 1) <> '0')
  ),
  asset_code TEXT NOT NULL,
  asset_scale INTEGER NOT NULL CHECK (asset_scale BETWEEN 0 AND 18),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organisation_id, name)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  reference TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (organisation_id, reference),
  UNIQUE (organisation_id, id)
);

CREATE TABLE job_participants (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  role TEXT NOT NULL CHECK (length(trim(role)) > 0),
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (job_id, participant_id, role)
);

CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  job_id TEXT REFERENCES jobs(id),
  reference TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'ISSUED', 'APPROVED', 'REJECTED', 'EXPIRED')),
  asset_code TEXT NOT NULL,
  total_atomic TEXT NOT NULL CHECK (
    total_atomic GLOB '[0-9]*'
    AND total_atomic NOT GLOB '*[^0-9]*'
    AND (total_atomic = '0' OR substr(total_atomic, 1, 1) <> '0')
  ),
  asset_scale INTEGER NOT NULL CHECK (asset_scale BETWEEN 0 AND 18),
  issued_at TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organisation_id, reference)
);

CREATE TABLE quote_lines (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id),
  service_id TEXT REFERENCES services(id),
  position INTEGER NOT NULL CHECK (position >= 0),
  description TEXT NOT NULL,
  quantity_atomic TEXT NOT NULL CHECK (
    quantity_atomic GLOB '[0-9]*'
    AND quantity_atomic NOT GLOB '*[^0-9]*'
    AND quantity_atomic <> '0'
    AND substr(quantity_atomic, 1, 1) <> '0'
  ),
  quantity_scale INTEGER NOT NULL CHECK (quantity_scale BETWEEN 0 AND 6),
  unit_price_atomic TEXT NOT NULL CHECK (
    unit_price_atomic GLOB '[0-9]*'
    AND unit_price_atomic NOT GLOB '*[^0-9]*'
    AND (unit_price_atomic = '0' OR substr(unit_price_atomic, 1, 1) <> '0')
  ),
  line_total_atomic TEXT NOT NULL CHECK (
    line_total_atomic GLOB '[0-9]*'
    AND line_total_atomic NOT GLOB '*[^0-9]*'
    AND (line_total_atomic = '0' OR substr(line_total_atomic, 1, 1) <> '0')
  ),
  UNIQUE (quote_id, position)
);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  job_id TEXT REFERENCES jobs(id),
  quote_id TEXT REFERENCES quotes(id),
  reference TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'ISSUED', 'PAID', 'VOID')),
  asset_code TEXT NOT NULL,
  total_atomic TEXT NOT NULL CHECK (
    total_atomic GLOB '[0-9]*'
    AND total_atomic NOT GLOB '*[^0-9]*'
    AND total_atomic <> '0'
    AND substr(total_atomic, 1, 1) <> '0'
  ),
  asset_scale INTEGER NOT NULL CHECK (asset_scale BETWEEN 0 AND 18),
  issued_at TEXT,
  due_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organisation_id, reference),
  UNIQUE (organisation_id, id)
);

CREATE TABLE invoice_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  service_id TEXT REFERENCES services(id),
  position INTEGER NOT NULL CHECK (position >= 0),
  description TEXT NOT NULL,
  quantity_atomic TEXT NOT NULL CHECK (
    quantity_atomic GLOB '[0-9]*'
    AND quantity_atomic NOT GLOB '*[^0-9]*'
    AND quantity_atomic <> '0'
    AND substr(quantity_atomic, 1, 1) <> '0'
  ),
  quantity_scale INTEGER NOT NULL CHECK (quantity_scale BETWEEN 0 AND 6),
  unit_price_atomic TEXT NOT NULL CHECK (
    unit_price_atomic GLOB '[0-9]*'
    AND unit_price_atomic NOT GLOB '*[^0-9]*'
    AND (unit_price_atomic = '0' OR substr(unit_price_atomic, 1, 1) <> '0')
  ),
  line_total_atomic TEXT NOT NULL CHECK (
    line_total_atomic GLOB '[0-9]*'
    AND line_total_atomic NOT GLOB '*[^0-9]*'
    AND (line_total_atomic = '0' OR substr(line_total_atomic, 1, 1) <> '0')
  ),
  UNIQUE (invoice_id, position)
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  external_reference TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED', 'REFUNDED')),
  asset_code TEXT NOT NULL,
  amount_atomic TEXT NOT NULL CHECK (
    amount_atomic GLOB '[0-9]*'
    AND amount_atomic NOT GLOB '*[^0-9]*'
    AND amount_atomic <> '0'
    AND substr(amount_atomic, 1, 1) <> '0'
  ),
  asset_scale INTEGER NOT NULL CHECK (asset_scale BETWEEN 0 AND 18),
  received_at TEXT NOT NULL,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organisation_id, external_reference),
  UNIQUE (organisation_id, id)
);

CREATE TABLE payment_state_transitions (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  payment_id TEXT NOT NULL REFERENCES payments(id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT,
  correlation_id TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64
    AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  occurred_at TEXT NOT NULL,
  UNIQUE (payment_id, to_status)
);

CREATE TABLE workshop_vehicles (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  registration TEXT NOT NULL,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organisation_id, registration)
);

CREATE TABLE workshop_job_details (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  vehicle_id TEXT NOT NULL REFERENCES workshop_vehicles(id),
  odometer INTEGER CHECK (odometer IS NULL OR odometer >= 0),
  reported_concern TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TRIGGER jobs_customer_tenant_scope_insert
BEFORE INSERT ON jobs
WHEN NOT EXISTS (
  SELECT 1 FROM customers
  WHERE id = NEW.customer_id AND organisation_id = NEW.organisation_id
)
BEGIN
  SELECT RAISE(ABORT, 'job customer must share its organisation');
END;

CREATE TRIGGER job_participants_tenant_scope_insert
BEFORE INSERT ON job_participants
WHEN NOT EXISTS (
  SELECT 1 FROM jobs j
  JOIN participants p ON p.id = NEW.participant_id
  WHERE j.id = NEW.job_id AND p.organisation_id = j.organisation_id
)
BEGIN
  SELECT RAISE(ABORT, 'job participant must share its organisation');
END;

CREATE TRIGGER invoices_tenant_scope_insert
BEFORE INSERT ON invoices
WHEN NOT EXISTS (
  SELECT 1 FROM customers c
  WHERE c.id = NEW.customer_id AND c.organisation_id = NEW.organisation_id
)
OR (
  NEW.job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM jobs j
    WHERE j.id = NEW.job_id AND j.organisation_id = NEW.organisation_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invoice references must share their organisation');
END;

CREATE TRIGGER quotes_tenant_scope_insert
BEFORE INSERT ON quotes
WHEN NOT EXISTS (
  SELECT 1 FROM customers c
  WHERE c.id = NEW.customer_id AND c.organisation_id = NEW.organisation_id
)
OR (
  NEW.job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM jobs j
    WHERE j.id = NEW.job_id AND j.organisation_id = NEW.organisation_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'quote references must share their organisation');
END;

CREATE TRIGGER payments_tenant_scope_insert
BEFORE INSERT ON payments
WHEN NOT EXISTS (
  SELECT 1 FROM invoices
  WHERE id = NEW.invoice_id AND organisation_id = NEW.organisation_id
)
BEGIN
  SELECT RAISE(ABORT, 'payment invoice must share its organisation');
END;

CREATE TRIGGER payments_status_transition_guard
BEFORE UPDATE OF status ON payments
WHEN NEW.status <> OLD.status
  AND NOT EXISTS (
    SELECT 1 FROM payment_state_transitions pst
    WHERE pst.payment_id = OLD.id
      AND pst.from_status = OLD.status
      AND pst.to_status = NEW.status
  )
BEGIN
  SELECT RAISE(ABORT, 'payment status transition must be recorded');
END;

CREATE TRIGGER payment_state_transitions_no_update
BEFORE UPDATE ON payment_state_transitions
BEGIN
  SELECT RAISE(ABORT, 'payment transitions are append-only');
END;

CREATE TRIGGER payment_state_transitions_no_delete
BEFORE DELETE ON payment_state_transitions
BEGIN
  SELECT RAISE(ABORT, 'payment transitions are append-only');
END;

CREATE TRIGGER workshop_job_details_tenant_scope_insert
BEFORE INSERT ON workshop_job_details
WHEN NOT EXISTS (
  SELECT 1 FROM jobs j
  JOIN workshop_vehicles v ON v.id = NEW.vehicle_id
  WHERE j.id = NEW.job_id
    AND j.organisation_id = NEW.organisation_id
    AND v.organisation_id = NEW.organisation_id
)
BEGIN
  SELECT RAISE(ABORT, 'workshop job details must share their organisation');
END;

CREATE TRIGGER workshop_vehicles_tenant_scope_insert
BEFORE INSERT ON workshop_vehicles
WHEN NOT EXISTS (
  SELECT 1 FROM customers
  WHERE id = NEW.customer_id AND organisation_id = NEW.organisation_id
)
BEGIN
  SELECT RAISE(ABORT, 'workshop vehicle customer must share its organisation');
END;
