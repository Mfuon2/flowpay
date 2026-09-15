ALTER TABLE escrow_state_transitions
ADD COLUMN command_fingerprint TEXT NOT NULL DEFAULT ''
CHECK (
  command_fingerprint = ''
  OR (
    length(command_fingerprint) = 64
    AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  )
);

ALTER TABLE escrow_milestone_verifications
ADD COLUMN command_fingerprint TEXT NOT NULL DEFAULT ''
CHECK (
  command_fingerprint = ''
  OR (
    length(command_fingerprint) = 64
    AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE TRIGGER escrow_arrangements_financial_terms_immutable
BEFORE UPDATE OF funding_payment_id, asset_code, amount_atomic, asset_scale
ON escrow_arrangements
BEGIN
  SELECT RAISE(ABORT, 'escrow financial terms are immutable');
END;

CREATE TRIGGER escrow_milestones_no_update
BEFORE UPDATE ON escrow_milestones
BEGIN
  SELECT RAISE(ABORT, 'escrow milestones are immutable');
END;

CREATE TRIGGER escrow_milestones_no_delete
BEFORE DELETE ON escrow_milestones
BEGIN
  SELECT RAISE(ABORT, 'escrow milestones are immutable');
END;
