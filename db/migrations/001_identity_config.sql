CREATE TABLE owner_users (
  owner_id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL CHECK (issuer = 'https://accounts.google.com'),
  subject TEXT NOT NULL,
  allowlisted INTEGER NOT NULL CHECK (allowlisted IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE (issuer, subject)
);
CREATE TABLE owner_sessions (
  session_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owner_users(owner_id),
  csrf_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (expires_at > created_at)
);
CREATE INDEX owner_sessions_expiry ON owner_sessions(expires_at);
CREATE TABLE worker_identities (
  worker_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owner_users(owner_id),
  credential_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (owner_id, worker_id)
);
CREATE TABLE config_versions (
  config_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES owner_users(owner_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, config_id, revision)
);
CREATE TRIGGER config_versions_no_update BEFORE UPDATE ON config_versions
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_CONFIG'); END;
CREATE TRIGGER config_versions_no_delete BEFORE DELETE ON config_versions
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_CONFIG'); END;
CREATE TABLE audit_events (
  event_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owner_users(owner_id),
  actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  target_id TEXT,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX audit_owner_time ON audit_events(owner_id, created_at, event_id);
CREATE TABLE oidc_login_intents (
  state_hash TEXT PRIMARY KEY,
  nonce_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  browser_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX oidc_intents_expiry ON oidc_login_intents(expires_at);
