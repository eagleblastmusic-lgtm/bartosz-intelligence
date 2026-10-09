-- Owner-approved private original transcript archive; no payload duplication.
CREATE TABLE transcript_archive_folders (
 owner_id TEXT PRIMARY KEY REFERENCES owner_users(owner_id), connection_id TEXT NOT NULL,
 parent_id TEXT NOT NULL, folder_id TEXT NOT NULL, private_verified_at TEXT,
 FOREIGN KEY(owner_id,connection_id) REFERENCES drive_connections(owner_id,connection_id)
);
CREATE TABLE transcript_archives (
 owner_id TEXT NOT NULL, item_id TEXT NOT NULL, source_artifact_id TEXT NOT NULL,
 segment_map_artifact_id TEXT NOT NULL, source_hash TEXT NOT NULL CHECK(length(source_hash)=64),
 descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json) AND length(CAST(descriptor_json AS BLOB))<=8192),
 folder_id TEXT NOT NULL, reserved_file_id TEXT, content_hash TEXT,
 verified_hash TEXT, verified_source_artifact_id TEXT, remote_version TEXT, verified_at TEXT,
 state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','RETRY_WAIT','VERIFIED','CONFLICT')),
 due_at TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, last_reason TEXT,
 lease_owner TEXT, lease_until TEXT, fencing_token INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL, PRIMARY KEY(owner_id,item_id),
 FOREIGN KEY(owner_id,item_id) REFERENCES items(owner_id,item_id)
);
CREATE INDEX transcript_archive_due ON transcript_archives(owner_id,state,due_at,item_id);
CREATE INDEX transcript_archive_sources ON artifacts(owner_id,created_at,artifact_id) WHERE kind='SOURCE_ORIGINAL' AND state='VERIFIED';
CREATE TRIGGER transcript_archive_retired_update BEFORE UPDATE ON transcript_archives
WHEN EXISTS(SELECT 1 FROM retention_items t WHERE t.owner_id=OLD.owner_id AND t.item_id=OLD.item_id AND t.phase IN ('PRUNING','COMPLETE'))
AND (NEW.source_artifact_id IS NOT OLD.source_artifact_id OR NEW.reserved_file_id IS NOT OLD.reserved_file_id OR NEW.verified_hash IS NOT OLD.verified_hash OR NEW.remote_version IS NOT OLD.remote_version OR NEW.state IS NOT OLD.state)
BEGIN SELECT RAISE(ABORT,'ARCHIVED_TRANSCRIPT_REQUIRES_RECOVERY'); END;
CREATE TRIGGER transcript_archive_folders_backup_insert BEFORE INSERT ON transcript_archive_folders WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER transcript_archive_folders_backup_update BEFORE UPDATE ON transcript_archive_folders WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER transcript_archive_folders_backup_delete BEFORE DELETE ON transcript_archive_folders WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER transcript_archives_backup_insert BEFORE INSERT ON transcript_archives WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER transcript_archives_backup_update BEFORE UPDATE ON transcript_archives WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER transcript_archives_backup_delete BEFORE DELETE ON transcript_archives WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
