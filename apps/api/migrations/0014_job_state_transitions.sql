CREATE TABLE job_state_transitions (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('START', 'COMPLETE', 'CANCEL')),
  actor_id TEXT NOT NULL,
  reason TEXT,
  correlation_id TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64
    AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  occurred_at TEXT NOT NULL,
  UNIQUE (job_id, to_status)
);

CREATE TRIGGER job_state_transitions_scope_and_state
BEFORE INSERT ON job_state_transitions
WHEN NOT EXISTS (
  SELECT 1 FROM jobs
  WHERE id = NEW.job_id
    AND organisation_id = NEW.organisation_id
    AND status = NEW.from_status
)
BEGIN
  SELECT RAISE(ABORT, 'stale or cross-organisation job transition');
END;

CREATE TRIGGER job_state_transitions_allowed
BEFORE INSERT ON job_state_transitions
WHEN NOT (
  (NEW.from_status = 'DRAFT' AND NEW.to_status = 'IN_PROGRESS' AND NEW.action = 'START')
  OR (NEW.from_status = 'IN_PROGRESS' AND NEW.to_status = 'COMPLETED' AND NEW.action = 'COMPLETE')
  OR (NEW.from_status = 'DRAFT' AND NEW.to_status = 'CANCELLED' AND NEW.action = 'CANCEL')
  OR (NEW.from_status = 'IN_PROGRESS' AND NEW.to_status = 'CANCELLED' AND NEW.action = 'CANCEL')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid job state transition');
END;

CREATE TRIGGER jobs_status_transition_guard
BEFORE UPDATE OF status ON jobs
WHEN NEW.status <> OLD.status AND NOT EXISTS (
  SELECT 1 FROM job_state_transitions jst
  WHERE jst.job_id = OLD.id
    AND jst.from_status = OLD.status
    AND jst.to_status = NEW.status
)
BEGIN
  SELECT RAISE(ABORT, 'job status transition must be recorded');
END;

CREATE TRIGGER job_state_transitions_no_update
BEFORE UPDATE ON job_state_transitions
BEGIN
  SELECT RAISE(ABORT, 'job transitions are append-only');
END;

CREATE TRIGGER job_state_transitions_no_delete
BEFORE DELETE ON job_state_transitions
BEGIN
  SELECT RAISE(ABORT, 'job transitions are append-only');
END;
