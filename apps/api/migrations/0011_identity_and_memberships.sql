CREATE TABLE application_users (
  id TEXT PRIMARY KEY,
  access_subject TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE organisation_memberships (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  user_id TEXT NOT NULL REFERENCES application_users(id),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organisation_id, user_id)
);

CREATE TABLE organisation_membership_roles (
  membership_id TEXT NOT NULL REFERENCES organisation_memberships(id),
  role TEXT NOT NULL CHECK (role IN (
    'OWNER', 'ADMIN', 'FINANCE', 'MANAGER', 'OPERATIONS', 'ACCOUNTANT', 'VIEWER'
  )),
  granted_at TEXT NOT NULL,
  PRIMARY KEY (membership_id, role)
);

CREATE INDEX idx_memberships_user
  ON organisation_memberships (user_id, status, organisation_id);
