-- Immutable technical companion for compact sources only. Historical artifacts
-- and accepted hashes are never rewritten. Payload eviction is separately gated.
CREATE TABLE transcript_payload_archives (
 owner_id TEXT NOT NULL, source_artifact_id TEXT NOT NULL, item_id TEXT NOT NULL,
 folder_id TEXT NOT NULL, connection_id TEXT NOT NULL, reserved_file_id TEXT NOT NULL,
 content_hash TEXT NOT NULL, artifact_ids_json TEXT NOT NULL CHECK(json_valid(artifact_ids_json)),
 state TEXT NOT NULL CHECK(state IN ('PENDING','VERIFIED')),
 remote_version TEXT, verified_at TEXT, permit_token TEXT, permit_until TEXT, evicted_at TEXT,
 PRIMARY KEY(owner_id,source_artifact_id), UNIQUE(owner_id,reserved_file_id),
 FOREIGN KEY(owner_id,item_id) REFERENCES items(owner_id,item_id)
);
CREATE TRIGGER transcript_payload_identity BEFORE UPDATE ON transcript_payload_archives
WHEN NEW.owner_id IS NOT OLD.owner_id OR NEW.source_artifact_id IS NOT OLD.source_artifact_id OR NEW.item_id IS NOT OLD.item_id OR NEW.folder_id IS NOT OLD.folder_id OR NEW.connection_id IS NOT OLD.connection_id OR NEW.reserved_file_id IS NOT OLD.reserved_file_id OR NEW.content_hash IS NOT OLD.content_hash OR NEW.artifact_ids_json IS NOT OLD.artifact_ids_json
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PAYLOAD_ARCHIVE'); END;
DROP TRIGGER artifact_chunks_no_delete;
CREATE TRIGGER artifact_chunks_no_delete BEFORE DELETE ON artifact_chunks
WHEN NOT EXISTS(SELECT 1 FROM retention_items t WHERE t.owner_id=OLD.owner_id AND t.item_id=OLD.item_id AND t.phase='PRUNING' AND t.permit_token IS NOT NULL)
AND NOT EXISTS(SELECT 1 FROM transcript_payload_archives p JOIN retention_settings r ON r.owner_id=p.owner_id
 WHERE p.owner_id=OLD.owner_id AND p.item_id=OLD.item_id AND p.state='VERIFIED' AND p.remote_version IS NOT NULL
 AND p.verified_at IS NOT NULL AND p.permit_token IS NOT NULL AND p.permit_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND r.deletion_enabled=1 AND r.approval_reference IS NOT NULL
 AND OLD.artifact_id IN (SELECT value FROM json_each(p.artifact_ids_json))
 AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.owner_id=p.owner_id AND j.item_id=p.item_id AND j.state IN ('PENDING','LEASED','RUNNING','DEFERRED','RETRY_WAIT'))
 AND NOT EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARTIFACT_CHUNK'); END;
CREATE TRIGGER transcript_payload_archives_backup_insert BEFORE INSERT ON transcript_payload_archives WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER transcript_payload_archives_backup_update BEFORE UPDATE ON transcript_payload_archives WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER transcript_payload_archives_backup_delete BEFORE DELETE ON transcript_payload_archives WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
