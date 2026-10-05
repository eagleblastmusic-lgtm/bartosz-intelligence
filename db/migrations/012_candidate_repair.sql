CREATE TABLE candidate_repair_attempts (
 owner_id TEXT NOT NULL,
 item_id TEXT NOT NULL,
 candidate_artifact_id TEXT NOT NULL,
 job_id TEXT NOT NULL,
 fencing_token INTEGER NOT NULL,
 request_id TEXT NOT NULL,
 estimated_repair_tokens INTEGER NOT NULL CHECK(estimated_repair_tokens>0),
 estimated_full_retry_tokens INTEGER NOT NULL CHECK(estimated_full_retry_tokens>0),
 error_class TEXT NOT NULL,
 measurement_hash TEXT NOT NULL CHECK(length(measurement_hash)=64),
 claimed_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,candidate_artifact_id),
 UNIQUE(owner_id,request_id),
 FOREIGN KEY(owner_id,item_id,candidate_artifact_id) REFERENCES artifacts(owner_id,item_id,artifact_id),
 FOREIGN KEY(owner_id,job_id) REFERENCES jobs(owner_id,job_id),
 CHECK(estimated_repair_tokens<=0.35*estimated_full_retry_tokens)
);
CREATE TRIGGER candidate_repair_no_update BEFORE UPDATE ON candidate_repair_attempts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REPAIR_ATTEMPT'); END;
CREATE TRIGGER candidate_repair_no_delete BEFORE DELETE ON candidate_repair_attempts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REPAIR_ATTEMPT'); END;
CREATE TRIGGER candidate_repair_backup_insert BEFORE INSERT ON candidate_repair_attempts WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
