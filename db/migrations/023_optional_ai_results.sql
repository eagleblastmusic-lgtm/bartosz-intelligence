CREATE TABLE optional_ai_results (
 owner_id TEXT NOT NULL, item_id TEXT NOT NULL, run_id TEXT NOT NULL,
 task_type TEXT NOT NULL CHECK(task_type IN ('TRANSLATE','HISTORICAL_COMPARE')),
 plan_hash TEXT NOT NULL CHECK(length(plan_hash)=64),
 canonical_artifact_id TEXT NOT NULL, canonical_hash TEXT NOT NULL CHECK(length(canonical_hash)=64),
 helper_artifact_id TEXT, mapping_artifact_id TEXT,
 source_artifact_id TEXT, source_hash TEXT,
 coverage_json TEXT NOT NULL CHECK(json_valid(coverage_json)),
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,run_id),
 FOREIGN KEY(owner_id,item_id) REFERENCES items(owner_id,item_id),
 FOREIGN KEY(owner_id,run_id) REFERENCES analysis_runs(owner_id,run_id),
 FOREIGN KEY(owner_id,item_id,canonical_artifact_id) REFERENCES artifacts(owner_id,item_id,artifact_id),
 FOREIGN KEY(owner_id,item_id,helper_artifact_id) REFERENCES artifacts(owner_id,item_id,artifact_id),
 FOREIGN KEY(owner_id,item_id,mapping_artifact_id) REFERENCES artifacts(owner_id,item_id,artifact_id),
 FOREIGN KEY(owner_id,item_id,source_artifact_id) REFERENCES artifacts(owner_id,item_id,artifact_id),
 CHECK((task_type='TRANSLATE' AND source_artifact_id IS NOT NULL AND length(source_hash)=64 AND helper_artifact_id IS NOT NULL AND mapping_artifact_id IS NOT NULL) OR
       (task_type='HISTORICAL_COMPARE' AND source_artifact_id IS NULL AND source_hash IS NULL AND helper_artifact_id IS NULL AND mapping_artifact_id IS NULL))
);
CREATE INDEX optional_results_item ON optional_ai_results(owner_id,item_id,task_type,created_at DESC,run_id);
CREATE TRIGGER optional_result_no_update BEFORE UPDATE ON optional_ai_results BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OPTIONAL_RESULT'); END;
CREATE TRIGGER optional_result_no_delete BEFORE DELETE ON optional_ai_results BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OPTIONAL_RESULT'); END;
CREATE TRIGGER optional_result_backup_insert BEFORE INSERT ON optional_ai_results WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER optional_result_accepted BEFORE INSERT ON optional_ai_results WHEN NOT EXISTS(SELECT 1 FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id WHERE r.owner_id=NEW.owner_id AND r.run_id=NEW.run_id AND r.item_id=NEW.item_id AND r.state='ACCEPTED' AND j.task_type=NEW.task_type) BEGIN SELECT RAISE(ABORT,'OPTIONAL_RESULT_NOT_ACCEPTED'); END;
CREATE TRIGGER projection_invalidate_optional_result_insert AFTER INSERT ON optional_ai_results BEGIN INSERT INTO change_log(owner_id,component,target_id,event_type,created_at) VALUES(NEW.owner_id,'optional_ai',NEW.item_id,'OPTIONAL_RESULT_ACCEPTED',NEW.created_at); END;
