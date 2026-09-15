ALTER TABLE business_events
ADD COLUMN deduplication_hash TEXT NOT NULL DEFAULT ''
CHECK (
  deduplication_hash = ''
  OR (
    length(deduplication_hash) = 64
    AND deduplication_hash NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE TABLE rule_evaluations (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  business_event_id TEXT NOT NULL UNIQUE REFERENCES business_events(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('NO_MATCH', 'MATCHED', 'CONFLICT')),
  matched_rule_version_id TEXT REFERENCES settlement_rule_versions(id),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  evaluated_at TEXT NOT NULL,
  CHECK (
    (outcome = 'MATCHED' AND matched_rule_version_id IS NOT NULL)
    OR (outcome <> 'MATCHED' AND matched_rule_version_id IS NULL)
  )
);

CREATE INDEX idx_rule_evaluations_outcome
  ON rule_evaluations (organisation_id, outcome, evaluated_at);

CREATE TRIGGER rule_evaluations_no_update
BEFORE UPDATE ON rule_evaluations
BEGIN
  SELECT RAISE(ABORT, 'rule evaluations are append-only');
END;

CREATE TRIGGER rule_evaluations_no_delete
BEFORE DELETE ON rule_evaluations
BEGIN
  SELECT RAISE(ABORT, 'rule evaluations are append-only');
END;

CREATE TRIGGER settlements_tenant_scope_insert
BEFORE INSERT ON settlements
WHEN NOT (
  EXISTS (
    SELECT 1 FROM business_events
    WHERE id = NEW.source_event_id
      AND organisation_id = NEW.organisation_id
  )
  AND EXISTS (
    SELECT 1
    FROM settlement_rule_versions srv
    JOIN settlement_rules sr ON sr.id = srv.rule_id
    WHERE srv.id = NEW.rule_version_id
      AND sr.organisation_id = NEW.organisation_id
  )
  AND (
    NEW.approval_policy_version_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM approval_policy_versions apv
      JOIN approval_policies ap ON ap.id = apv.policy_id
      WHERE apv.id = NEW.approval_policy_version_id
        AND ap.organisation_id = NEW.organisation_id
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'settlement references must share an organisation');
END;

CREATE TRIGGER settlement_distributions_beneficiary_scope_insert
BEFORE INSERT ON settlement_distributions
WHEN NOT EXISTS (
  SELECT 1
  FROM settlements s
  JOIN participants p ON p.id = NEW.beneficiary_id
  WHERE s.id = NEW.settlement_id
    AND p.organisation_id = s.organisation_id
    AND p.status = 'ACTIVE'
)
BEGIN
  SELECT RAISE(ABORT, 'beneficiary must be active in the settlement organisation');
END;

CREATE TRIGGER approval_requests_tenant_scope_insert
BEFORE INSERT ON approval_requests
WHEN NOT EXISTS (
  SELECT 1
  FROM settlements s
  JOIN approval_policy_versions apv ON apv.id = NEW.policy_version_id
  JOIN approval_policies ap ON ap.id = apv.policy_id
  WHERE s.id = NEW.settlement_id
    AND s.organisation_id = NEW.organisation_id
    AND ap.organisation_id = NEW.organisation_id
)
BEGIN
  SELECT RAISE(ABORT, 'approval request references must share an organisation');
END;
