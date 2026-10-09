-- Owner-approved Drive-only retention. Destructive mode starts disabled.
CREATE TABLE retention_settings (
 owner_id TEXT PRIMARY KEY REFERENCES owner_users(owner_id),
 deletion_enabled INTEGER NOT NULL DEFAULT 0 CHECK(deletion_enabled IN (0,1)),
 approval_reference TEXT, next_check_at TEXT, last_receipt_json TEXT CHECK(last_receipt_json IS NULL OR json_valid(last_receipt_json))
);
CREATE TABLE daily_export_members (
 owner_id TEXT NOT NULL, artifact_id TEXT NOT NULL, item_id TEXT NOT NULL,
 run_id TEXT NOT NULL, canonical_hash TEXT NOT NULL CHECK(length(canonical_hash)=64),
 PRIMARY KEY(owner_id,artifact_id,item_id),
 FOREIGN KEY(owner_id,artifact_id) REFERENCES daily_export_artifacts(owner_id,artifact_id),
 FOREIGN KEY(owner_id,item_id) REFERENCES items(owner_id,item_id)
);
CREATE TABLE retention_items (
 owner_id TEXT NOT NULL, item_id TEXT NOT NULL, accepted_run_id TEXT NOT NULL,
 canonical_hash TEXT NOT NULL CHECK(length(canonical_hash)=64),
 root_id TEXT NOT NULL, publication_date TEXT NOT NULL, artifact_id TEXT NOT NULL,
 file_id TEXT NOT NULL, remote_version TEXT NOT NULL, export_revision INTEGER NOT NULL,
 file_hash TEXT NOT NULL CHECK(length(file_hash)=64), verified_at TEXT NOT NULL, purge_after TEXT NOT NULL,
 phase TEXT NOT NULL DEFAULT 'WAITING' CHECK(phase IN ('WAITING','PRUNING','COMPLETE')),
 step INTEGER NOT NULL DEFAULT 0, cursor INTEGER NOT NULL DEFAULT 0,
 deleted_rows INTEGER NOT NULL DEFAULT 0, deleted_bytes INTEGER NOT NULL DEFAULT 0,
 step_bytes INTEGER NOT NULL DEFAULT 0, permit_token TEXT,
 operational_json TEXT CHECK(operational_json IS NULL OR (json_valid(operational_json) AND length(CAST(operational_json AS BLOB))<=8192)),
 hold_reason TEXT, last_block_reason TEXT, updated_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,item_id), FOREIGN KEY(owner_id,item_id) REFERENCES items(owner_id,item_id)
);
CREATE INDEX retention_due ON retention_items(owner_id,purge_after,item_id) WHERE phase!='COMPLETE';
CREATE INDEX retention_report ON retention_items(owner_id,root_id,publication_date,phase);
CREATE INDEX artifact_chunk_retention ON artifact_chunks(owner_id,item_id);
CREATE INDEX run_item_cleanup ON analysis_runs(owner_id,item_id,run_id);
CREATE TRIGGER retention_report_locked BEFORE UPDATE ON export_state
WHEN EXISTS(SELECT 1 FROM retention_items t WHERE t.owner_id=OLD.owner_id AND t.root_id=OLD.root_namespace AND t.publication_date=OLD.publication_date AND t.phase IN ('PRUNING','COMPLETE'))
AND (NEW.file_id IS NOT OLD.file_id OR NEW.full_file_hash IS NOT OLD.full_file_hash OR NEW.revision!=OLD.revision)
BEGIN SELECT RAISE(ABORT,'ARCHIVED_REPORT_REQUIRES_RECOVERY'); END;
CREATE TRIGGER retention_job_insert BEFORE INSERT ON jobs
WHEN NEW.item_id IS NOT NULL AND EXISTS(SELECT 1 FROM retention_items WHERE owner_id=NEW.owner_id AND item_id=NEW.item_id AND phase IN ('PRUNING','COMPLETE'))
AND NOT EXISTS(SELECT 1 FROM jobs WHERE owner_id=NEW.owner_id AND dedup_key=NEW.dedup_key)
BEGIN SELECT RAISE(ABORT,'ARCHIVED_ITEM_REQUIRES_RECOVERY'); END;
CREATE TRIGGER retention_job_restart BEFORE UPDATE OF state ON jobs
WHEN NEW.state!=OLD.state AND NEW.state IN ('PENDING','LEASED','RUNNING') AND EXISTS(SELECT 1 FROM retention_items WHERE owner_id=NEW.owner_id AND item_id=NEW.item_id AND phase IN ('PRUNING','COMPLETE'))
BEGIN SELECT RAISE(ABORT,'ARCHIVED_ITEM_REQUIRES_RECOVERY'); END;

DROP TRIGGER artifact_no_delete;
CREATE TRIGGER artifact_no_delete BEFORE DELETE ON artifacts WHEN NOT EXISTS(SELECT 1 FROM retention_items t WHERE t.owner_id=OLD.owner_id AND t.item_id=OLD.item_id AND t.phase='PRUNING' AND t.permit_token IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARTIFACT'); END;

DROP TRIGGER artifact_chunks_no_delete;
CREATE TRIGGER artifact_chunks_no_delete BEFORE DELETE ON artifact_chunks WHEN NOT EXISTS(SELECT 1 FROM retention_items t WHERE t.owner_id=OLD.owner_id AND t.item_id=OLD.item_id AND t.phase='PRUNING' AND t.permit_token IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARTIFACT_CHUNK'); END;

DROP TRIGGER representation_no_delete;
CREATE TRIGGER representation_no_delete BEFORE DELETE ON transcript_representations WHEN NOT EXISTS(SELECT 1 FROM retention_items t WHERE t.owner_id=OLD.owner_id AND t.item_id=OLD.item_id AND t.phase='PRUNING' AND t.permit_token IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REPRESENTATION'); END;

DROP TRIGGER candidate_repair_no_delete;
CREATE TRIGGER candidate_repair_no_delete BEFORE DELETE ON candidate_repair_attempts WHEN NOT EXISTS(SELECT 1 FROM retention_items t WHERE t.owner_id=OLD.owner_id AND t.item_id=OLD.item_id AND t.phase='PRUNING' AND t.permit_token IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REPAIR_ATTEMPT'); END;

DROP TRIGGER optional_result_no_delete;
CREATE TRIGGER optional_result_no_delete BEFORE DELETE ON optional_ai_results WHEN NOT EXISTS(SELECT 1 FROM retention_items t WHERE t.owner_id=OLD.owner_id AND t.item_id=OLD.item_id AND t.phase='PRUNING' AND t.permit_token IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OPTIONAL_RESULT'); END;

DROP TRIGGER evidence_no_delete;
CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence WHEN NOT EXISTS(SELECT 1 FROM retention_items t WHERE t.owner_id=OLD.owner_id AND t.item_id=OLD.item_id AND t.phase='PRUNING' AND t.permit_token IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EVIDENCE'); END;

DROP TRIGGER observations_no_delete;
CREATE TRIGGER observations_no_delete BEFORE DELETE ON observations WHEN NOT EXISTS(SELECT 1 FROM retention_items t WHERE t.owner_id=OLD.owner_id AND t.item_id=(SELECT item_id FROM analysis_runs WHERE owner_id=OLD.owner_id AND run_id=OLD.run_id) AND t.phase='PRUNING' AND t.permit_token IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OBSERVATION'); END;

DROP TRIGGER analysis_evidence_no_delete;
CREATE TRIGGER analysis_evidence_no_delete BEFORE DELETE ON analysis_evidence WHEN NOT EXISTS(SELECT 1 FROM retention_items t WHERE t.owner_id=OLD.owner_id AND t.item_id=(SELECT item_id FROM analysis_runs WHERE owner_id=OLD.owner_id AND run_id=OLD.run_id) AND t.phase='PRUNING' AND t.permit_token IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RUN_EVIDENCE'); END;

DROP TRIGGER observation_evidence_no_delete;
CREATE TRIGGER observation_evidence_no_delete BEFORE DELETE ON observation_evidence WHEN NOT EXISTS(SELECT 1 FROM retention_items t WHERE t.owner_id=OLD.owner_id AND t.item_id=(SELECT r.item_id FROM observations o JOIN analysis_runs r ON r.owner_id=o.owner_id AND r.run_id=o.run_id WHERE o.owner_id=OLD.owner_id AND o.observation_id=OLD.observation_id) AND t.phase='PRUNING' AND t.permit_token IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OBSERVATION_JOIN'); END;

DROP TRIGGER observation_entities_no_delete;
CREATE TRIGGER observation_entities_no_delete BEFORE DELETE ON observation_entities WHEN NOT EXISTS(SELECT 1 FROM retention_items t WHERE t.owner_id=OLD.owner_id AND t.item_id=(SELECT r.item_id FROM observations o JOIN analysis_runs r ON r.owner_id=o.owner_id AND r.run_id=o.run_id WHERE o.owner_id=OLD.owner_id AND o.observation_id=OLD.observation_id) AND t.phase='PRUNING' AND t.permit_token IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OBSERVATION_JOIN'); END;

DROP TRIGGER runs_snapshot_immutable;
CREATE TRIGGER runs_snapshot_immutable BEFORE UPDATE OF input_snapshot_json,profile_snapshot_json,prompt_snapshot_json,wire_schema_version,canonical_schema_version,enrichment_version,routing_snapshot_json ON analysis_runs
WHEN NOT (EXISTS(SELECT 1 FROM retention_items t WHERE t.owner_id=OLD.owner_id AND t.item_id=OLD.item_id AND t.phase='PRUNING' AND t.permit_token IS NOT NULL) AND NEW.input_snapshot_json='{}' AND NEW.profile_snapshot_json='{}' AND NEW.prompt_snapshot_json IS NULL AND NEW.routing_snapshot_json='{}' AND NEW.wire_schema_version IS OLD.wire_schema_version AND NEW.canonical_schema_version IS OLD.canonical_schema_version AND NEW.enrichment_version IS OLD.enrichment_version)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RUN_SNAPSHOT'); END;
DROP TRIGGER runs_accepted_immutable;
CREATE TRIGGER runs_accepted_immutable BEFORE UPDATE ON analysis_runs WHEN OLD.state='ACCEPTED' AND NOT (EXISTS(SELECT 1 FROM retention_items t WHERE t.owner_id=OLD.owner_id AND t.item_id=OLD.item_id AND t.phase='PRUNING' AND t.permit_token IS NOT NULL) AND NEW.owner_id=OLD.owner_id AND NEW.item_id=OLD.item_id AND NEW.run_id=OLD.run_id AND NEW.job_id=OLD.job_id AND NEW.state=OLD.state AND NEW.candidate_hash IS OLD.candidate_hash AND NEW.created_at=OLD.created_at AND NEW.accepted_at IS OLD.accepted_at AND NEW.validation_outcome IS OLD.validation_outcome AND NEW.input_snapshot_json='{}' AND NEW.profile_snapshot_json='{}' AND NEW.prompt_snapshot_json IS NULL AND NEW.routing_snapshot_json='{}' AND NEW.outcome_json='{"version":"intelligence-archived:1"}')
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ACCEPTED_RUN'); END;

DROP TRIGGER jobs_origin_immutable;
CREATE TRIGGER jobs_origin_immutable BEFORE UPDATE OF arrival_origin_at,origin_kind,dedup_key,input_revision,profile_revision,prompt_snapshot_id,wire_schema_version,canonical_schema_version,enrichment_version,explicit_run_nonce,routing_policy_version,payload_json ON jobs
WHEN (NEW.arrival_origin_at IS NOT OLD.arrival_origin_at OR NEW.origin_kind IS NOT OLD.origin_kind OR NEW.dedup_key IS NOT OLD.dedup_key OR NEW.input_revision IS NOT OLD.input_revision OR NEW.profile_revision IS NOT OLD.profile_revision OR NEW.prompt_snapshot_id IS NOT OLD.prompt_snapshot_id OR NEW.wire_schema_version IS NOT OLD.wire_schema_version OR NEW.canonical_schema_version IS NOT OLD.canonical_schema_version OR NEW.enrichment_version IS NOT OLD.enrichment_version OR NEW.explicit_run_nonce IS NOT OLD.explicit_run_nonce OR NEW.routing_policy_version IS NOT OLD.routing_policy_version OR NEW.payload_json IS NOT OLD.payload_json)
AND NOT (EXISTS(SELECT 1 FROM retention_items t WHERE t.owner_id=OLD.owner_id AND t.item_id=OLD.item_id AND t.phase='PRUNING' AND t.permit_token IS NOT NULL) AND OLD.state='SUCCEEDED' AND NEW.state='SUCCEEDED' AND NEW.payload_json='{}' AND NEW.arrival_origin_at IS OLD.arrival_origin_at AND NEW.origin_kind IS OLD.origin_kind AND NEW.dedup_key IS OLD.dedup_key AND NEW.input_revision IS OLD.input_revision AND NEW.profile_revision IS OLD.profile_revision AND NEW.prompt_snapshot_id IS OLD.prompt_snapshot_id AND NEW.wire_schema_version IS OLD.wire_schema_version AND NEW.canonical_schema_version IS OLD.canonical_schema_version AND NEW.enrichment_version IS OLD.enrichment_version AND NEW.explicit_run_nonce IS OLD.explicit_run_nonce AND NEW.routing_policy_version IS OLD.routing_policy_version)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_JOB_INPUT'); END;
CREATE TRIGGER retention_settings_backup_insert BEFORE INSERT ON retention_settings WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;

CREATE TRIGGER retention_settings_backup_update BEFORE UPDATE ON retention_settings WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;

CREATE TRIGGER retention_settings_backup_delete BEFORE DELETE ON retention_settings WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;

CREATE TRIGGER daily_export_members_backup_insert BEFORE INSERT ON daily_export_members WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;

CREATE TRIGGER daily_export_members_backup_update BEFORE UPDATE ON daily_export_members WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;

CREATE TRIGGER daily_export_members_backup_delete BEFORE DELETE ON daily_export_members WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;

CREATE TRIGGER retention_items_backup_insert BEFORE INSERT ON retention_items WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;

CREATE TRIGGER retention_items_backup_update BEFORE UPDATE ON retention_items WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;

CREATE TRIGGER retention_items_backup_delete BEFORE DELETE ON retention_items WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;

CREATE INDEX artifact_retention_children ON artifacts(owner_id,original_ref,artifact_id);
DROP TRIGGER daily_export_complete_before_seal;
CREATE TRIGGER daily_export_complete_before_seal BEFORE UPDATE OF state ON daily_export_artifacts
WHEN NEW.state='SEALED' AND ((SELECT COUNT(*) FROM daily_export_chunks WHERE owner_id=NEW.owner_id AND artifact_id=NEW.artifact_id)!=NEW.chunk_count OR (SELECT COALESCE(SUM(byte_count),0) FROM daily_export_chunks WHERE owner_id=NEW.owner_id AND artifact_id=NEW.artifact_id)!=NEW.byte_count OR EXISTS(SELECT 1 FROM daily_export_chunks WHERE owner_id=NEW.owner_id AND artifact_id=NEW.artifact_id AND (ordinal>=NEW.chunk_count OR byte_count!=MIN(32768,NEW.byte_count-ordinal*32768))))
AND NOT (NOT EXISTS(SELECT 1 FROM daily_export_chunks WHERE owner_id=NEW.owner_id AND artifact_id=NEW.artifact_id) AND EXISTS(SELECT 1 FROM retention_items t WHERE t.owner_id=NEW.owner_id AND t.root_id=NEW.root_id AND t.publication_date=NEW.publication_date AND (t.phase='COMPLETE' OR (t.phase='PRUNING' AND t.step>=14))) AND NOT EXISTS(SELECT 1 FROM daily_export_members m LEFT JOIN retention_items t ON t.owner_id=m.owner_id AND t.item_id=m.item_id WHERE m.owner_id=NEW.owner_id AND m.artifact_id=NEW.artifact_id AND (t.phase IS NULL OR t.phase='WAITING')))
BEGIN SELECT RAISE(ABORT,'EXPORT_ARTIFACT_INCOMPLETE'); END;
