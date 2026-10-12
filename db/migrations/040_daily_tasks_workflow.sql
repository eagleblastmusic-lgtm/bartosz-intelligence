-- Additive namespace. Existing archives, summaries and AI selections are untouched.
CREATE TABLE daily_workflow_settings (
 owner_id TEXT PRIMARY KEY REFERENCES owner_users(owner_id), connection_id TEXT NOT NULL,
 transcript_root_id TEXT NOT NULL, report_root_id TEXT NOT NULL, staging_folder_id TEXT,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), started_at TEXT NOT NULL,
 private_verified_at TEXT NOT NULL, lease_owner TEXT, lease_until TEXT,
 fencing_token INTEGER NOT NULL DEFAULT 0, inbox_scan_after_date TEXT, updated_at TEXT NOT NULL,
 FOREIGN KEY(owner_id,connection_id) REFERENCES drive_connections(owner_id,connection_id)
);
CREATE TABLE daily_materials (
 owner_id TEXT NOT NULL, item_id TEXT NOT NULL, video_id TEXT NOT NULL,
 material_date TEXT NOT NULL, acquired_at TEXT NOT NULL, source_artifact_id TEXT NOT NULL,
 segment_map_artifact_id TEXT NOT NULL, source_hash TEXT NOT NULL CHECK(length(source_hash)=64),
 descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json) AND length(CAST(descriptor_json AS BLOB))<=16384),
 archive_attempt_count INTEGER NOT NULL DEFAULT 0, archive_due_at TEXT, archive_reason TEXT,
 PRIMARY KEY(owner_id,item_id), UNIQUE(owner_id,video_id),
 FOREIGN KEY(owner_id,item_id) REFERENCES items(owner_id,item_id)
);
CREATE INDEX daily_material_date ON daily_materials(owner_id,material_date,video_id);
CREATE TRIGGER daily_material_immutable BEFORE UPDATE ON daily_materials
WHEN NEW.owner_id IS NOT OLD.owner_id OR NEW.item_id IS NOT OLD.item_id OR NEW.video_id IS NOT OLD.video_id OR NEW.material_date IS NOT OLD.material_date OR NEW.acquired_at IS NOT OLD.acquired_at OR NEW.source_artifact_id IS NOT OLD.source_artifact_id OR NEW.segment_map_artifact_id IS NOT OLD.segment_map_artifact_id OR NEW.source_hash IS NOT OLD.source_hash OR NEW.descriptor_json IS NOT OLD.descriptor_json
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DAILY_MATERIAL'); END;
CREATE TABLE daily_collections (
 owner_id TEXT NOT NULL REFERENCES owner_users(owner_id), material_date TEXT NOT NULL,
 closed_at TEXT, state TEXT NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','WAITING_FILES','READY')),
 manifest_json TEXT CHECK(manifest_json IS NULL OR (json_valid(manifest_json) AND length(CAST(manifest_json AS BLOB))<=1048576)),
 manifest_hash TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(owner_id,material_date)
);
CREATE TABLE daily_drive_folders (
 owner_id TEXT NOT NULL REFERENCES owner_users(owner_id), parent_id TEXT NOT NULL, name TEXT NOT NULL,
 folder_id TEXT NOT NULL, verified_at TEXT, PRIMARY KEY(owner_id,parent_id,name)
);
CREATE TABLE daily_drive_files (
 owner_id TEXT NOT NULL REFERENCES owner_users(owner_id), object_key TEXT NOT NULL,
 folder_id TEXT NOT NULL, name TEXT NOT NULL, reserved_file_id TEXT NOT NULL,
 content_hash TEXT NOT NULL, verified_hash TEXT, remote_version TEXT, verified_at TEXT,
 state TEXT NOT NULL CHECK(state IN ('PENDING','RETRY_WAIT','VERIFIED','CONFLICT')),
 attempt_count INTEGER NOT NULL DEFAULT 0, due_at TEXT NOT NULL, reason TEXT, updated_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,object_key), UNIQUE(owner_id,reserved_file_id)
);
CREATE INDEX daily_drive_due ON daily_drive_files(owner_id,state,due_at,object_key);
CREATE TABLE daily_reports (
 owner_id TEXT NOT NULL REFERENCES owner_users(owner_id), material_date TEXT NOT NULL,
 manifest_hash TEXT NOT NULL, content_hash TEXT NOT NULL, report_json TEXT NOT NULL
 CHECK(json_valid(report_json) AND length(CAST(report_json AS BLOB))<=1048576),
 file_id TEXT NOT NULL, source_file_id TEXT NOT NULL, remote_version TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('COMPLETE','PARTIAL')), verified_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,material_date)
);
CREATE TABLE daily_report_inbox (
 owner_id TEXT NOT NULL REFERENCES owner_users(owner_id), file_id TEXT NOT NULL,
 material_date TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('PENDING','RETRY_WAIT','IMPORTED','REJECTED')),
 attempt_count INTEGER NOT NULL DEFAULT 0, observed_version TEXT, due_at TEXT NOT NULL, reason TEXT, updated_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,file_id)
);
CREATE TRIGGER daily_workflow_settings_backup_insert BEFORE INSERT ON daily_workflow_settings WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_workflow_settings_backup_update BEFORE UPDATE ON daily_workflow_settings WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_workflow_settings_backup_delete BEFORE DELETE ON daily_workflow_settings WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_materials_backup_insert BEFORE INSERT ON daily_materials WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_materials_backup_update BEFORE UPDATE ON daily_materials WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_materials_backup_delete BEFORE DELETE ON daily_materials WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_collections_backup_insert BEFORE INSERT ON daily_collections WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_collections_backup_update BEFORE UPDATE ON daily_collections WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_collections_backup_delete BEFORE DELETE ON daily_collections WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_drive_folders_backup_insert BEFORE INSERT ON daily_drive_folders WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_drive_folders_backup_update BEFORE UPDATE ON daily_drive_folders WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_drive_folders_backup_delete BEFORE DELETE ON daily_drive_folders WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_drive_files_backup_insert BEFORE INSERT ON daily_drive_files WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_drive_files_backup_update BEFORE UPDATE ON daily_drive_files WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_drive_files_backup_delete BEFORE DELETE ON daily_drive_files WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_reports_backup_insert BEFORE INSERT ON daily_reports WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_reports_backup_update BEFORE UPDATE ON daily_reports WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_reports_backup_delete BEFORE DELETE ON daily_reports WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_report_inbox_backup_insert BEFORE INSERT ON daily_report_inbox WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_report_inbox_backup_update BEFORE UPDATE ON daily_report_inbox WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_report_inbox_backup_delete BEFORE DELETE ON daily_report_inbox WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
