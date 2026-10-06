CREATE TABLE correction_overlays (
 owner_id TEXT NOT NULL REFERENCES owner_users(owner_id), correction_id TEXT NOT NULL,
 target_kind TEXT NOT NULL CHECK(target_kind IN ('OBSERVATION_TEXT','ENTITY_LABEL')), target_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), target_hash TEXT NOT NULL CHECK(length(target_hash)=64),
 original_value TEXT NOT NULL, old_value TEXT NOT NULL, new_value TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('APPLY','REVERT')), reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 authored_by TEXT NOT NULL CHECK(authored_by=owner_id), request_hash TEXT NOT NULL CHECK(length(request_hash)=64), recorded_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,correction_id), UNIQUE(owner_id,target_kind,target_id,revision)
);
CREATE INDEX correction_target_latest ON correction_overlays(owner_id,target_kind,target_id,revision DESC);
CREATE TRIGGER correction_validate BEFORE INSERT ON correction_overlays
WHEN NEW.revision!=COALESCE((SELECT MAX(revision) FROM correction_overlays WHERE owner_id=NEW.owner_id AND target_kind=NEW.target_kind AND target_id=NEW.target_id),0)+1
 OR (NEW.target_kind='OBSERVATION_TEXT' AND NOT EXISTS(SELECT 1 FROM observations WHERE owner_id=NEW.owner_id AND observation_id=NEW.target_id AND row_hash=NEW.target_hash AND json_extract(row_json,'$.content_pl')=NEW.original_value))
 OR (NEW.target_kind='ENTITY_LABEL' AND NOT EXISTS(SELECT 1 FROM entities WHERE owner_id=NEW.owner_id AND entity_id=NEW.target_id AND label=NEW.original_value))
 OR NEW.old_value IS NOT COALESCE((SELECT new_value FROM correction_overlays WHERE owner_id=NEW.owner_id AND target_kind=NEW.target_kind AND target_id=NEW.target_id ORDER BY revision DESC LIMIT 1),NEW.original_value)
BEGIN SELECT RAISE(ABORT,'INVALID_CORRECTION_OVERLAY'); END;
CREATE TRIGGER correction_no_update BEFORE UPDATE ON correction_overlays BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CORRECTION'); END;
CREATE TRIGGER correction_no_delete BEFORE DELETE ON correction_overlays BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CORRECTION'); END;
CREATE TRIGGER correction_backup_insert BEFORE INSERT ON correction_overlays WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER projection_invalidate_correction_insert AFTER INSERT ON correction_overlays
BEGIN INSERT INTO change_log(owner_id,component,target_id,event_type,created_at) VALUES(NEW.owner_id,'corrections',NEW.target_id,'CORRECTION_CHANGED',NEW.recorded_at); END;
