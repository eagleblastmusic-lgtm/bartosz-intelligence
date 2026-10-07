CREATE TABLE drive_export_attempts (
  owner_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  reserved_remote_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK(fencing_token>=1),
  state TEXT NOT NULL DEFAULT 'PREPARED' CHECK(state IN ('PREPARED','VERIFIED','CONFLICT')),
  reason TEXT,
  remote_version TEXT,
  verified_hash TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,artifact_id),
  FOREIGN KEY(owner_id,artifact_id) REFERENCES daily_export_artifacts(owner_id,artifact_id)
);
CREATE TRIGGER drive_export_attempt_identity BEFORE UPDATE ON drive_export_attempts
WHEN NEW.owner_id!=OLD.owner_id OR NEW.artifact_id!=OLD.artifact_id OR NEW.reserved_remote_id!=OLD.reserved_remote_id
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EXPORT_ATTEMPT_IDENTITY'); END;
CREATE TRIGGER drive_export_attempt_backup_insert BEFORE INSERT ON drive_export_attempts WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER drive_export_attempt_backup_update BEFORE UPDATE ON drive_export_attempts WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER drive_export_attempt_backup_delete BEFORE DELETE ON drive_export_attempts WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
