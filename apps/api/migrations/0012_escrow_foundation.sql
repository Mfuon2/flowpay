CREATE TABLE escrow_arrangements (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  funding_payment_id TEXT REFERENCES payments(id),
  asset_code TEXT NOT NULL,
  amount_atomic TEXT NOT NULL CHECK (
    amount_atomic GLOB '[0-9]*'
    AND amount_atomic NOT GLOB '*[^0-9]*'
    AND amount_atomic <> '0'
    AND substr(amount_atomic, 1, 1) <> '0'
  ),
  asset_scale INTEGER NOT NULL CHECK (asset_scale BETWEEN 0 AND 18),
  state TEXT NOT NULL CHECK (state IN (
    'DRAFT', 'AWAITING_FUNDING', 'FUNDED', 'PARTIALLY_RELEASED',
    'RELEASED', 'DISPUTED', 'CANCELLED'
  )),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organisation_id, id)
);

CREATE TABLE escrow_milestones (
  id TEXT PRIMARY KEY,
  escrow_arrangement_id TEXT NOT NULL REFERENCES escrow_arrangements(id),
  position INTEGER NOT NULL CHECK (position >= 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  verification_event_type TEXT NOT NULL CHECK (length(trim(verification_event_type)) > 0),
  asset_code TEXT NOT NULL,
  release_amount_atomic TEXT NOT NULL CHECK (
    release_amount_atomic GLOB '[0-9]*'
    AND release_amount_atomic NOT GLOB '*[^0-9]*'
    AND release_amount_atomic <> '0'
    AND substr(release_amount_atomic, 1, 1) <> '0'
  ),
  asset_scale INTEGER NOT NULL CHECK (asset_scale BETWEEN 0 AND 18),
  created_at TEXT NOT NULL,
  UNIQUE (escrow_arrangement_id, position)
);

CREATE TABLE escrow_milestone_verifications (
  id TEXT PRIMARY KEY,
  escrow_milestone_id TEXT NOT NULL UNIQUE REFERENCES escrow_milestones(id),
  business_event_id TEXT NOT NULL UNIQUE REFERENCES business_events(id),
  verified_by TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  verified_at TEXT NOT NULL
);

CREATE TABLE escrow_milestone_releases (
  id TEXT PRIMARY KEY,
  escrow_milestone_id TEXT NOT NULL UNIQUE REFERENCES escrow_milestones(id),
  settlement_id TEXT NOT NULL UNIQUE REFERENCES settlements(id),
  released_at TEXT NOT NULL
);

CREATE TABLE escrow_state_transitions (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  escrow_arrangement_id TEXT NOT NULL REFERENCES escrow_arrangements(id),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  from_version INTEGER NOT NULL CHECK (from_version >= 0),
  to_version INTEGER NOT NULL CHECK (to_version = from_version + 1),
  action TEXT NOT NULL CHECK (action IN (
    'ACTIVATE', 'CONFIRM_FUNDING', 'RELEASE_PARTIAL', 'RELEASE_FINAL',
    'OPEN_DISPUTE', 'RESOLVE_TO_FUNDED',
    'RESOLVE_TO_PARTIALLY_RELEASED', 'CANCEL'
  )),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('USER', 'SERVICE', 'PROVIDER')),
  actor_id TEXT NOT NULL,
  reason TEXT,
  correlation_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (escrow_arrangement_id, to_version)
);

CREATE INDEX idx_escrow_arrangements_state
  ON escrow_arrangements (organisation_id, state, updated_at);

CREATE TRIGGER escrow_arrangements_payment_scope_insert
BEFORE INSERT ON escrow_arrangements
WHEN NEW.funding_payment_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM payments
  WHERE id = NEW.funding_payment_id
    AND organisation_id = NEW.organisation_id
)
BEGIN
  SELECT RAISE(ABORT, 'escrow funding payment must share its organisation');
END;

CREATE TRIGGER escrow_milestones_precision_insert
BEFORE INSERT ON escrow_milestones
WHEN NOT EXISTS (
  SELECT 1 FROM escrow_arrangements ea
  WHERE ea.id = NEW.escrow_arrangement_id
    AND ea.asset_code = NEW.asset_code
    AND ea.asset_scale = NEW.asset_scale
)
BEGIN
  SELECT RAISE(ABORT, 'escrow milestone must match arrangement precision');
END;

CREATE TRIGGER escrow_state_transitions_match_current
BEFORE INSERT ON escrow_state_transitions
WHEN NOT EXISTS (
  SELECT 1 FROM escrow_arrangements ea
  WHERE ea.id = NEW.escrow_arrangement_id
    AND ea.organisation_id = NEW.organisation_id
    AND ea.state = NEW.from_state
    AND ea.state_version = NEW.from_version
)
BEGIN
  SELECT RAISE(ABORT, 'stale or cross-organisation escrow transition');
END;

CREATE TRIGGER escrow_state_transitions_allowed
BEFORE INSERT ON escrow_state_transitions
WHEN NOT (
  (NEW.from_state = 'DRAFT' AND NEW.to_state = 'AWAITING_FUNDING' AND NEW.action = 'ACTIVATE')
  OR (NEW.from_state = 'DRAFT' AND NEW.to_state = 'CANCELLED' AND NEW.action = 'CANCEL')
  OR (NEW.from_state = 'AWAITING_FUNDING' AND NEW.to_state = 'FUNDED' AND NEW.action = 'CONFIRM_FUNDING')
  OR (NEW.from_state = 'AWAITING_FUNDING' AND NEW.to_state = 'CANCELLED' AND NEW.action = 'CANCEL')
  OR (NEW.from_state = 'FUNDED' AND NEW.to_state = 'PARTIALLY_RELEASED' AND NEW.action = 'RELEASE_PARTIAL')
  OR (NEW.from_state = 'FUNDED' AND NEW.to_state = 'RELEASED' AND NEW.action = 'RELEASE_FINAL')
  OR (NEW.from_state = 'FUNDED' AND NEW.to_state = 'DISPUTED' AND NEW.action = 'OPEN_DISPUTE')
  OR (NEW.from_state = 'FUNDED' AND NEW.to_state = 'CANCELLED' AND NEW.action = 'CANCEL')
  OR (NEW.from_state = 'PARTIALLY_RELEASED' AND NEW.to_state = 'PARTIALLY_RELEASED' AND NEW.action = 'RELEASE_PARTIAL')
  OR (NEW.from_state = 'PARTIALLY_RELEASED' AND NEW.to_state = 'RELEASED' AND NEW.action = 'RELEASE_FINAL')
  OR (NEW.from_state = 'PARTIALLY_RELEASED' AND NEW.to_state = 'DISPUTED' AND NEW.action = 'OPEN_DISPUTE')
  OR (NEW.from_state = 'DISPUTED' AND NEW.to_state = 'FUNDED' AND NEW.action = 'RESOLVE_TO_FUNDED')
  OR (NEW.from_state = 'DISPUTED' AND NEW.to_state = 'PARTIALLY_RELEASED' AND NEW.action = 'RESOLVE_TO_PARTIALLY_RELEASED')
  OR (NEW.from_state = 'DISPUTED' AND NEW.to_state = 'CANCELLED' AND NEW.action = 'CANCEL')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid escrow state transition');
END;

CREATE TRIGGER escrow_arrangements_state_transition_guard
BEFORE UPDATE OF state ON escrow_arrangements
WHEN NEW.state <> OLD.state AND NOT EXISTS (
  SELECT 1 FROM escrow_state_transitions est
  WHERE est.escrow_arrangement_id = OLD.id
    AND est.from_state = OLD.state
    AND est.to_state = NEW.state
    AND est.from_version = OLD.state_version
    AND est.to_version = NEW.state_version
    AND (
      (OLD.state = 'DRAFT' AND NEW.state = 'AWAITING_FUNDING' AND est.action = 'ACTIVATE')
      OR (OLD.state = 'DRAFT' AND NEW.state = 'CANCELLED' AND est.action = 'CANCEL')
      OR (OLD.state = 'AWAITING_FUNDING' AND NEW.state = 'FUNDED' AND est.action = 'CONFIRM_FUNDING')
      OR (OLD.state = 'AWAITING_FUNDING' AND NEW.state = 'CANCELLED' AND est.action = 'CANCEL')
      OR (OLD.state = 'FUNDED' AND NEW.state = 'PARTIALLY_RELEASED' AND est.action = 'RELEASE_PARTIAL')
      OR (OLD.state = 'FUNDED' AND NEW.state = 'RELEASED' AND est.action = 'RELEASE_FINAL')
      OR (OLD.state = 'FUNDED' AND NEW.state = 'DISPUTED' AND est.action = 'OPEN_DISPUTE')
      OR (OLD.state = 'FUNDED' AND NEW.state = 'CANCELLED' AND est.action = 'CANCEL')
      OR (OLD.state = 'PARTIALLY_RELEASED' AND NEW.state = 'RELEASED' AND est.action = 'RELEASE_FINAL')
      OR (OLD.state = 'PARTIALLY_RELEASED' AND NEW.state = 'DISPUTED' AND est.action = 'OPEN_DISPUTE')
      OR (OLD.state = 'DISPUTED' AND NEW.state = 'FUNDED' AND est.action = 'RESOLVE_TO_FUNDED')
      OR (OLD.state = 'DISPUTED' AND NEW.state = 'PARTIALLY_RELEASED' AND est.action = 'RESOLVE_TO_PARTIALLY_RELEASED')
      OR (OLD.state = 'DISPUTED' AND NEW.state = 'CANCELLED' AND est.action = 'CANCEL')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'escrow state transition must be recorded and allowed');
END;

CREATE TRIGGER escrow_arrangements_state_version_guard
BEFORE UPDATE OF state_version ON escrow_arrangements
WHEN NEW.state_version <> OLD.state_version
  AND NEW.state_version <> OLD.state_version + 1
BEGIN
  SELECT RAISE(ABORT, 'escrow state version must increment exactly once');
END;

CREATE TRIGGER escrow_state_transitions_no_update
BEFORE UPDATE ON escrow_state_transitions
BEGIN
  SELECT RAISE(ABORT, 'escrow transitions are append-only');
END;

CREATE TRIGGER escrow_state_transitions_no_delete
BEFORE DELETE ON escrow_state_transitions
BEGIN
  SELECT RAISE(ABORT, 'escrow transitions are append-only');
END;

CREATE TRIGGER escrow_verifications_no_update
BEFORE UPDATE ON escrow_milestone_verifications
BEGIN
  SELECT RAISE(ABORT, 'escrow verification evidence is append-only');
END;

CREATE TRIGGER escrow_verifications_no_delete
BEFORE DELETE ON escrow_milestone_verifications
BEGIN
  SELECT RAISE(ABORT, 'escrow verification evidence is append-only');
END;

CREATE TRIGGER escrow_releases_no_update
BEFORE UPDATE ON escrow_milestone_releases
BEGIN
  SELECT RAISE(ABORT, 'escrow release links are append-only');
END;

CREATE TRIGGER escrow_releases_no_delete
BEFORE DELETE ON escrow_milestone_releases
BEGIN
  SELECT RAISE(ABORT, 'escrow release links are append-only');
END;
