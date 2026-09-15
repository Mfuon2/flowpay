ALTER TABLE settlement_provider_transactions
ADD COLUMN observation_attempts INTEGER NOT NULL DEFAULT 0
CHECK (observation_attempts >= 0);

ALTER TABLE settlement_provider_transactions
ADD COLUMN next_observation_at TEXT;

ALTER TABLE settlement_provider_transactions
ADD COLUMN last_observation_error TEXT;

CREATE INDEX idx_provider_transactions_due_observation
  ON settlement_provider_transactions (
    provider,
    status,
    next_observation_at,
    updated_at
  );
