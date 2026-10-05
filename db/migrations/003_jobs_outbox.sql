CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owner_users(owner_id),
  item_id TEXT,
  source_id TEXT,
  task_type TEXT NOT NULL CHECK (task_type IN ('DISCOVER','RECONCILE','FETCH_TRANSCRIPT','NORMALIZE','ANALYZE','TRANSLATE','HISTORICAL_COMPARE','REPROCESS','PROJECT','EXPORT_DAY','BACKUP')),
  input_revision TEXT NOT NULL,
  profile_revision TEXT NOT NULL,
  prompt_snapshot_id TEXT,
  routing_policy_version TEXT NOT NULL,
  wire_schema_version TEXT,
  canonical_schema_version TEXT,
  enrichment_version TEXT,
  explicit_run_nonce TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING','LEASED','RUNNING','SUCCEEDED','DEFERRED','RETRY_WAIT','BLOCKED','FAILED')),
  reason_code TEXT,
  due_at TEXT NOT NULL,
  priority INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  lease_owner TEXT,
  lease_until TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK(fencing_token>=0),
  result_candidate_id TEXT,
  arrival_origin_at TEXT NOT NULL,
  origin_kind TEXT NOT NULL CHECK(origin_kind IN ('NEW','BACKFILL','MANUAL','INTEGRITY')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(owner_id,item_id) REFERENCES items(owner_id,item_id),
  FOREIGN KEY(owner_id,source_id) REFERENCES sources(owner_id,source_id),
  FOREIGN KEY(owner_id,lease_owner) REFERENCES worker_identities(owner_id,worker_id),
  UNIQUE(owner_id,dedup_key),
  UNIQUE(owner_id,job_id),
  CHECK((state IN ('LEASED','RUNNING') AND lease_owner IS NOT NULL AND lease_until IS NOT NULL) OR state NOT IN ('LEASED','RUNNING'))
);
CREATE INDEX jobs_due ON jobs(owner_id,state,due_at,priority,job_id);
CREATE INDEX jobs_expired ON jobs(state,lease_until,job_id);
CREATE INDEX jobs_origin ON jobs(owner_id,origin_kind,arrival_origin_at,job_id);
CREATE TRIGGER jobs_origin_immutable BEFORE UPDATE OF arrival_origin_at,origin_kind,dedup_key,input_revision,profile_revision,prompt_snapshot_id,wire_schema_version,canonical_schema_version,enrichment_version,explicit_run_nonce,routing_policy_version,payload_json ON jobs
WHEN NEW.arrival_origin_at IS NOT OLD.arrival_origin_at OR NEW.origin_kind IS NOT OLD.origin_kind OR NEW.dedup_key IS NOT OLD.dedup_key OR NEW.input_revision IS NOT OLD.input_revision OR NEW.profile_revision IS NOT OLD.profile_revision OR NEW.prompt_snapshot_id IS NOT OLD.prompt_snapshot_id OR NEW.wire_schema_version IS NOT OLD.wire_schema_version OR NEW.canonical_schema_version IS NOT OLD.canonical_schema_version OR NEW.enrichment_version IS NOT OLD.enrichment_version OR NEW.explicit_run_nonce IS NOT OLD.explicit_run_nonce OR NEW.routing_policy_version IS NOT OLD.routing_policy_version OR NEW.payload_json IS NOT OLD.payload_json
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_JOB_INPUT'); END;
CREATE TRIGGER jobs_transition_guard BEFORE UPDATE OF state ON jobs
WHEN OLD.state<>NEW.state AND NOT (
  (OLD.state='PENDING' AND NEW.state='LEASED') OR
  (OLD.state='LEASED' AND NEW.state IN ('RUNNING','RETRY_WAIT')) OR
  (OLD.state='RUNNING' AND NEW.state IN ('SUCCEEDED','DEFERRED','RETRY_WAIT','BLOCKED','FAILED')) OR
  (OLD.state IN ('DEFERRED','RETRY_WAIT','BLOCKED','FAILED') AND NEW.state='PENDING')
)
BEGIN SELECT RAISE(ABORT,'ILLEGAL_JOB_TRANSITION'); END;
CREATE TABLE job_attempts (
  attempt_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  executor_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT,
  commit_nonce TEXT,
  candidate_hash TEXT,
  FOREIGN KEY(owner_id,job_id) REFERENCES jobs(owner_id,job_id),
  FOREIGN KEY(owner_id,executor_id) REFERENCES worker_identities(owner_id,worker_id),
  UNIQUE(owner_id,job_id,fencing_token)
);
CREATE TABLE outbox (
  event_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  job_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  due_at TEXT NOT NULL,
  delivered_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  FOREIGN KEY(owner_id,job_id) REFERENCES jobs(owner_id,job_id),
  UNIQUE(owner_id,event_key)
);
CREATE INDEX outbox_due ON outbox(delivered_at,due_at,event_id);
