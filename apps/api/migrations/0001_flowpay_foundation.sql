PRAGMA foreign_keys = ON;

CREATE TABLE organisations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 160),
  participant_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organisation_id, id)
);

CREATE TABLE approval_policies (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organisation_id, name)
);

CREATE TABLE approval_policy_versions (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES approval_policies(id),
  version INTEGER NOT NULL CHECK (version > 0),
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (policy_id, version)
);

CREATE TABLE settlement_rules (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organisation_id, name)
);

CREATE TABLE settlement_rule_versions (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES settlement_rules(id),
  version INTEGER NOT NULL CHECK (version > 0),
  trigger_event_type TEXT NOT NULL,
  trigger_schema_version INTEGER NOT NULL CHECK (trigger_schema_version > 0),
  priority INTEGER NOT NULL DEFAULT 0,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  conditions_json TEXT NOT NULL CHECK (json_valid(conditions_json)),
  beneficiaries_json TEXT NOT NULL CHECK (json_valid(beneficiaries_json)),
  provider_policy_json TEXT NOT NULL CHECK (json_valid(provider_policy_json)),
  approval_policy_version_id TEXT REFERENCES approval_policy_versions(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  UNIQUE (rule_id, version)
);

CREATE TABLE business_events (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  source TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (organisation_id, source, external_event_id)
);

CREATE INDEX idx_business_events_trigger
  ON business_events (organisation_id, event_type, occurred_at);

CREATE TABLE settlements (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  source_event_id TEXT NOT NULL REFERENCES business_events(id),
  rule_version_id TEXT NOT NULL REFERENCES settlement_rule_versions(id),
  approval_policy_version_id TEXT REFERENCES approval_policy_versions(id),
  asset_code TEXT NOT NULL,
  amount_atomic TEXT NOT NULL CHECK (
    amount_atomic GLOB '[0-9]*'
    AND amount_atomic NOT GLOB '*[^0-9]*'
    AND (amount_atomic = '0' OR substr(amount_atomic, 1, 1) <> '0')
  ),
  asset_scale INTEGER NOT NULL CHECK (asset_scale BETWEEN 0 AND 18),
  state TEXT NOT NULL CHECK (state IN (
    'DRAFT', 'PENDING_RULE_EVALUATION', 'PENDING_APPROVAL', 'READY',
    'SUBMITTING', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'CANCELLED', 'REVERSED'
  )),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  evaluation_evidence_json TEXT NOT NULL CHECK (json_valid(evaluation_evidence_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_event_id, rule_version_id)
);

CREATE INDEX idx_settlements_state
  ON settlements (organisation_id, state, updated_at);

CREATE TABLE settlement_distributions (
  id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL REFERENCES settlements(id),
  beneficiary_id TEXT NOT NULL REFERENCES participants(id),
  position INTEGER NOT NULL CHECK (position >= 0),
  calculation_kind TEXT NOT NULL CHECK (calculation_kind IN ('PERCENTAGE', 'FIXED', 'REMAINDER')),
  calculation_json TEXT NOT NULL CHECK (json_valid(calculation_json)),
  asset_code TEXT NOT NULL,
  amount_atomic TEXT NOT NULL CHECK (
    amount_atomic GLOB '[0-9]*'
    AND amount_atomic NOT GLOB '*[^0-9]*'
    AND (amount_atomic = '0' OR substr(amount_atomic, 1, 1) <> '0')
  ),
  asset_scale INTEGER NOT NULL CHECK (asset_scale BETWEEN 0 AND 18),
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'SUBMITTING', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'REVERSED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (settlement_id, position),
  UNIQUE (settlement_id, beneficiary_id)
);

CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  settlement_id TEXT NOT NULL UNIQUE REFERENCES settlements(id),
  policy_version_id TEXT NOT NULL REFERENCES approval_policy_versions(id),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  requirements_json TEXT NOT NULL CHECK (json_valid(requirements_json)),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE approval_decisions (
  id TEXT PRIMARY KEY,
  approval_request_id TEXT NOT NULL REFERENCES approval_requests(id),
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('APPROVE', 'REJECT')),
  reason TEXT,
  decided_at TEXT NOT NULL,
  UNIQUE (approval_request_id, actor_id)
);

CREATE TABLE settlement_attempts (
  id TEXT PRIMARY KEY,
  settlement_distribution_id TEXT NOT NULL REFERENCES settlement_distributions(id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('STARTED', 'ACCEPTED', 'CONFIRMED', 'RETRYABLE_FAILURE', 'TERMINAL_FAILURE', 'OUTCOME_UNKNOWN')),
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (settlement_distribution_id, attempt_number)
);

CREATE TABLE settlement_provider_transactions (
  id TEXT PRIMARY KEY,
  settlement_attempt_id TEXT NOT NULL UNIQUE REFERENCES settlement_attempts(id),
  provider TEXT NOT NULL,
  provider_transaction_id TEXT,
  network TEXT,
  network_transaction_reference TEXT,
  status TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, provider_transaction_id)
);

CREATE TABLE provider_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  normalized_event_json TEXT NOT NULL CHECK (json_valid(normalized_event_json)),
  processed_at TEXT,
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE ledger_accounts (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  asset_code TEXT NOT NULL,
  asset_scale INTEGER NOT NULL CHECK (asset_scale BETWEEN 0 AND 18),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TEXT NOT NULL,
  UNIQUE (organisation_id, code)
);

CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  posting_purpose TEXT NOT NULL,
  posting_policy_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'POSTED', 'REVERSED')),
  effective_at TEXT NOT NULL,
  posted_at TEXT,
  reversal_of_id TEXT REFERENCES journal_entries(id),
  created_at TEXT NOT NULL,
  UNIQUE (organisation_id, source_type, source_id, posting_purpose)
);

CREATE TABLE journal_lines (
  id TEXT PRIMARY KEY,
  journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id),
  ledger_account_id TEXT NOT NULL REFERENCES ledger_accounts(id),
  position INTEGER NOT NULL CHECK (position >= 0),
  direction TEXT NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  asset_code TEXT NOT NULL,
  amount_atomic TEXT NOT NULL CHECK (
    amount_atomic GLOB '[0-9]*'
    AND amount_atomic NOT GLOB '*[^0-9]*'
    AND amount_atomic <> '0'
    AND substr(amount_atomic, 1, 1) <> '0'
  ),
  asset_scale INTEGER NOT NULL CHECK (asset_scale BETWEEN 0 AND 18),
  memo TEXT,
  UNIQUE (journal_entry_id, position)
);

CREATE TABLE reconciliation_records (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  settlement_distribution_id TEXT NOT NULL REFERENCES settlement_distributions(id),
  provider_transaction_id TEXT REFERENCES settlement_provider_transactions(id),
  journal_entry_id TEXT REFERENCES journal_entries(id),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'MATCHED', 'MISMATCHED', 'RESOLVED')),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  resolution_json TEXT CHECK (resolution_json IS NULL OR json_valid(resolution_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (settlement_distribution_id)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('USER', 'SERVICE', 'PROVIDER')),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_audit_timeline
  ON audit_events (organisation_id, aggregate_type, aggregate_id, occurred_at);

CREATE TABLE outbox_messages (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  message_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  dispatch_attempts INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
  next_attempt_at TEXT,
  last_error TEXT
);

CREATE INDEX idx_outbox_pending
  ON outbox_messages (dispatched_at, next_attempt_at, created_at);

CREATE TABLE inbox_messages (
  consumer_name TEXT NOT NULL,
  message_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  completed_at TEXT,
  last_error TEXT,
  PRIMARY KEY (consumer_name, message_id)
);

CREATE TRIGGER business_events_no_update
BEFORE UPDATE ON business_events
BEGIN
  SELECT RAISE(ABORT, 'business events are append-only');
END;

CREATE TRIGGER business_events_no_delete
BEFORE DELETE ON business_events
BEGIN
  SELECT RAISE(ABORT, 'business events are append-only');
END;

CREATE TRIGGER rule_versions_no_update
BEFORE UPDATE ON settlement_rule_versions
BEGIN
  SELECT RAISE(ABORT, 'settlement rule versions are immutable');
END;

CREATE TRIGGER rule_versions_no_delete
BEFORE DELETE ON settlement_rule_versions
BEGIN
  SELECT RAISE(ABORT, 'settlement rule versions are immutable');
END;

CREATE TRIGGER approval_policy_versions_no_update
BEFORE UPDATE ON approval_policy_versions
BEGIN
  SELECT RAISE(ABORT, 'approval policy versions are immutable');
END;

CREATE TRIGGER approval_policy_versions_no_delete
BEFORE DELETE ON approval_policy_versions
BEGIN
  SELECT RAISE(ABORT, 'approval policy versions are immutable');
END;

CREATE TRIGGER approval_decisions_no_update
BEFORE UPDATE ON approval_decisions
BEGIN
  SELECT RAISE(ABORT, 'approval decisions are append-only');
END;

CREATE TRIGGER approval_decisions_no_delete
BEFORE DELETE ON approval_decisions
BEGIN
  SELECT RAISE(ABORT, 'approval decisions are append-only');
END;

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;
