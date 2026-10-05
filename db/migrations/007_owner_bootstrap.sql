ALTER TABLE oidc_login_intents ADD COLUMN purpose TEXT NOT NULL DEFAULT 'LOGIN' CHECK(purpose IN ('LOGIN','BOOTSTRAP'));
CREATE TABLE owner_bootstrap_grants (
  grant_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  state_hash TEXT UNIQUE REFERENCES oidc_login_intents(state_hash),
  consumed_at TEXT
);
