-- Offline Drive authorization is separate from owner login and its cookies.
-- Connection metadata is portable; secret envelopes/intents are private and
-- excluded from the ordinary secret-free Core backup.
CREATE TABLE drive_connections (
  owner_id TEXT NOT NULL REFERENCES owner_users(owner_id),
  connection_id TEXT NOT NULL,
  account_subject TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json) AND json_type(scopes_json)='array'),
  auth_state TEXT NOT NULL CHECK(auth_state IN ('CONNECTED','REAUTH_REQUIRED','REVOKED')),
  publishing_state TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(publishing_state IN ('UNKNOWN','TESTING','PRODUCTION','INTERNAL')),
  root_id TEXT,
  root_state TEXT NOT NULL DEFAULT 'UNSELECTED' CHECK(root_state IN ('UNSELECTED','VERIFY_REQUIRED','VERIFIED','DENIED')),
  revision INTEGER NOT NULL CHECK(revision>=1),
  last_intent_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_refresh_at TEXT,
  last_refresh_receipt TEXT,
  last_error TEXT,
  PRIMARY KEY(owner_id,connection_id)
);
CREATE TABLE drive_credentials (
  owner_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json) AND json_extract(envelope_json,'$.version')='drive-refresh-aes256gcm:1'),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,connection_id),
  FOREIGN KEY(owner_id,connection_id) REFERENCES drive_connections(owner_id,connection_id)
);
CREATE TABLE drive_oauth_intents (
  state_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owner_users(owner_id),
  connection_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  wrapping_key_id TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  browser_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX drive_oauth_expiry ON drive_oauth_intents(expires_at);
CREATE TRIGGER drive_connection_backup_insert BEFORE INSERT ON drive_connections WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER drive_connection_backup_update BEFORE UPDATE ON drive_connections WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER drive_connection_backup_delete BEFORE DELETE ON drive_connections WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
