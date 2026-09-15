ALTER TABLE settlement_state_transitions
ADD COLUMN command_fingerprint TEXT NOT NULL DEFAULT ''
CHECK (
  command_fingerprint = ''
  OR (
    length(command_fingerprint) = 64
    AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  )
);
