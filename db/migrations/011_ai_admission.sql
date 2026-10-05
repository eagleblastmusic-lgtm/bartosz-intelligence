CREATE TABLE model_registry (
 owner_id TEXT NOT NULL REFERENCES owner_users(owner_id),
 profile_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 content_hash TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,profile_id,revision)
);
CREATE TRIGGER model_registry_no_update BEFORE UPDATE ON model_registry BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MODEL_SNAPSHOT'); END;
CREATE TRIGGER model_registry_no_delete BEFORE DELETE ON model_registry BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MODEL_SNAPSHOT'); END;
CREATE TABLE quota_reservations (
 reservation_id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 job_id TEXT NOT NULL,
 fencing_token INTEGER NOT NULL,
 request_id TEXT NOT NULL,
 provider TEXT NOT NULL,
 model TEXT NOT NULL,
 account_key TEXT NOT NULL,
 snapshots_json TEXT NOT NULL CHECK(json_valid(snapshots_json)),
 input_tokens INTEGER NOT NULL CHECK(input_tokens>=0),
 charged_input_tokens INTEGER NOT NULL CHECK(charged_input_tokens>=0),
 state TEXT NOT NULL CHECK(state IN ('RESERVED','SUBMITTED','SETTLED','UNKNOWN','CANCELLED')),
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 settled_at TEXT,
 FOREIGN KEY(owner_id,job_id) REFERENCES jobs(owner_id,job_id),
 UNIQUE(owner_id,request_id),
 UNIQUE(owner_id,reservation_id)
);
CREATE INDEX quota_reservations_window ON quota_reservations(account_key,provider,model,created_at,state);
CREATE TABLE usage_records (
 usage_id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 reservation_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 input_tokens INTEGER,
 output_tokens INTEGER,
 total_tokens INTEGER,
 actual_model TEXT,
 finish_reason TEXT NOT NULL,
 observed_at TEXT NOT NULL,
 FOREIGN KEY(owner_id,reservation_id) REFERENCES quota_reservations(owner_id,reservation_id),
 UNIQUE(owner_id,reservation_id)
);
CREATE TRIGGER usage_records_no_update BEFORE UPDATE ON usage_records BEGIN SELECT RAISE(ABORT,'IMMUTABLE_USAGE'); END;
CREATE TRIGGER usage_records_no_delete BEFORE DELETE ON usage_records BEGIN SELECT RAISE(ABORT,'IMMUTABLE_USAGE'); END;
CREATE TRIGGER model_registry_backup_insert BEFORE INSERT ON model_registry WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER quota_reservations_backup_insert BEFORE INSERT ON quota_reservations WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER quota_reservations_backup_update BEFORE UPDATE ON quota_reservations WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER usage_records_backup_insert BEFORE INSERT ON usage_records WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
