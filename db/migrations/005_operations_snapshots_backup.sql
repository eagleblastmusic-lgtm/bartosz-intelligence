CREATE TABLE provider_health (
  owner_id TEXT NOT NULL REFERENCES owner_users(owner_id),
  provider TEXT NOT NULL,
  runtime TEXT NOT NULL,
  version TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('HEALTHY','DEGRADED','OPEN_CIRCUIT','HALF_OPEN','UNKNOWN')),
  sampled_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  evidence_ref TEXT,
  PRIMARY KEY(owner_id,provider,runtime,version,sampled_at)
);
CREATE TABLE quota_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owner_users(owner_id),
  provider TEXT NOT NULL,
  model TEXT,
  bucket TEXT NOT NULL,
  units TEXT NOT NULL,
  limit_value REAL,
  used_value REAL,
  remaining REAL CHECK(remaining IS NULL OR remaining>=0),
  reset_at TEXT,
  reset_zone TEXT,
  source TEXT NOT NULL CHECK(source IN ('api','dashboard','local_counter','estimate')),
  sampled_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  confidence TEXT NOT NULL
);
CREATE INDEX quota_latest ON quota_snapshots(owner_id,provider,model,bucket,sampled_at);
CREATE TABLE worker_sessions (
  owner_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  runtime TEXT NOT NULL CHECK(runtime IN ('local','cloud')),
  capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)),
  heartbeat_at TEXT NOT NULL,
  online_until TEXT NOT NULL,
  FOREIGN KEY(owner_id,worker_id) REFERENCES worker_identities(owner_id,worker_id),
  PRIMARY KEY(owner_id,worker_id)
);
CREATE TABLE change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL REFERENCES owner_users(owner_id),
  component TEXT NOT NULL,
  target_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX change_owner_seq ON change_log(owner_id,seq);
CREATE TABLE maintenance_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  generation INTEGER NOT NULL DEFAULT 0,
  barrier_token TEXT,
  barrier_until TEXT,
  cut_seq INTEGER
);
INSERT INTO maintenance_state(singleton) VALUES(1);
CREATE TABLE source_requests (
  owner_id TEXT NOT NULL REFERENCES owner_users(owner_id),
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  permit_nonce TEXT NOT NULL,
  source_id TEXT,
  job_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(owner_id,source_id) REFERENCES sources(owner_id,source_id),
  FOREIGN KEY(owner_id,job_id) REFERENCES jobs(owner_id,job_id),
  PRIMARY KEY(owner_id,idempotency_key)
);
CREATE TABLE discovery_scans (
  scan_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  cursor TEXT,
  page_revision INTEGER NOT NULL DEFAULT 0,
  pages_committed INTEGER NOT NULL DEFAULT 0,
  enumerated_count INTEGER NOT NULL DEFAULT 0,
  coverage TEXT NOT NULL CHECK(coverage IN ('PENDING','PARTIAL','COMPLETE','BLOCKED')),
  last_page_hash TEXT,
  commit_nonce TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(owner_id,source_id) REFERENCES sources(owner_id,source_id),
  FOREIGN KEY(owner_id,job_id) REFERENCES jobs(owner_id,job_id),
  UNIQUE(owner_id,job_id)
);
ALTER TABLE sources ADD COLUMN window_start TEXT;
ALTER TABLE sources ADD COLUMN rss_due_at TEXT;
ALTER TABLE sources ADD COLUMN head_due_at TEXT;
ALTER TABLE sources ADD COLUMN full_due_at TEXT;
ALTER TABLE sources ADD COLUMN weekly_due_at TEXT;
ALTER TABLE sources ADD COLUMN rss_etag TEXT;
ALTER TABLE sources ADD COLUMN rss_modified TEXT;
ALTER TABLE sources ADD COLUMN last_rss_at TEXT;
