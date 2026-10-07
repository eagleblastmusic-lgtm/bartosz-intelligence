CREATE TABLE drive_root_candidates (
  owner_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  candidate_name TEXT NOT NULL,
  reserved_folder_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PREPARED' CHECK(state IN ('PREPARED','CREATED')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,connection_id,candidate_name),
  UNIQUE(owner_id,reserved_folder_id),
  FOREIGN KEY(owner_id,connection_id) REFERENCES drive_connections(owner_id,connection_id)
);
CREATE TRIGGER drive_root_candidate_identity BEFORE UPDATE ON drive_root_candidates
WHEN NEW.owner_id!=OLD.owner_id OR NEW.connection_id!=OLD.connection_id OR NEW.candidate_name!=OLD.candidate_name OR NEW.reserved_folder_id!=OLD.reserved_folder_id
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DRIVE_ROOT_CANDIDATE'); END;
CREATE TRIGGER drive_root_candidate_backup_insert BEFORE INSERT ON drive_root_candidates WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER drive_root_candidate_backup_update BEFORE UPDATE ON drive_root_candidates WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER drive_root_candidate_backup_delete BEFORE DELETE ON drive_root_candidates WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
