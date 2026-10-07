CREATE TABLE daily_export_artifacts (
  owner_id TEXT NOT NULL REFERENCES owner_users(owner_id),
  artifact_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  publication_date TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  source_change_seq INTEGER NOT NULL CHECK(source_change_seq>=0),
  mode TEXT NOT NULL CHECK(mode IN ('COMPACT','FULL')),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  body_hash TEXT NOT NULL CHECK(length(body_hash)=64),
  byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 1 AND 8388608),
  chunk_count INTEGER NOT NULL CHECK(chunk_count BETWEEN 1 AND 256),
  state TEXT NOT NULL DEFAULT 'STAGING' CHECK(state IN ('STAGING','SEALED')),
  PRIMARY KEY(owner_id,artifact_id),
  UNIQUE(owner_id,root_id,publication_date,revision)
);
CREATE TABLE daily_export_chunks (
  owner_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 255),
  byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 1 AND 32768),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  data_base64 TEXT NOT NULL CHECK(length(data_base64)<=43691),
  PRIMARY KEY(owner_id,artifact_id,ordinal),
  FOREIGN KEY(owner_id,artifact_id) REFERENCES daily_export_artifacts(owner_id,artifact_id)
);
ALTER TABLE export_state ADD COLUMN rendered_artifact_id TEXT;
CREATE TRIGGER daily_export_initial_staging BEFORE INSERT ON daily_export_artifacts
WHEN NEW.state!='STAGING'
BEGIN SELECT RAISE(ABORT,'EXPORT_ARTIFACT_INCOMPLETE'); END;
CREATE TRIGGER daily_export_complete_before_seal BEFORE UPDATE OF state ON daily_export_artifacts
WHEN NEW.state='SEALED' AND ((SELECT COUNT(*) FROM daily_export_chunks WHERE owner_id=NEW.owner_id AND artifact_id=NEW.artifact_id)!=NEW.chunk_count OR (SELECT COALESCE(SUM(byte_count),0) FROM daily_export_chunks WHERE owner_id=NEW.owner_id AND artifact_id=NEW.artifact_id)!=NEW.byte_count OR EXISTS(SELECT 1 FROM daily_export_chunks WHERE owner_id=NEW.owner_id AND artifact_id=NEW.artifact_id AND (ordinal>=NEW.chunk_count OR byte_count!=MIN(32768,NEW.byte_count-ordinal*32768))))
BEGIN SELECT RAISE(ABORT,'EXPORT_ARTIFACT_INCOMPLETE'); END;
CREATE TRIGGER daily_export_manifest_immutable BEFORE UPDATE ON daily_export_artifacts
WHEN OLD.state='SEALED' OR NEW.owner_id!=OLD.owner_id OR NEW.artifact_id!=OLD.artifact_id OR NEW.root_id!=OLD.root_id OR NEW.publication_date!=OLD.publication_date OR NEW.revision!=OLD.revision OR NEW.source_change_seq!=OLD.source_change_seq OR NEW.mode!=OLD.mode OR NEW.content_hash!=OLD.content_hash OR NEW.body_hash!=OLD.body_hash OR NEW.byte_count!=OLD.byte_count OR NEW.chunk_count!=OLD.chunk_count
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EXPORT_ARTIFACT'); END;
CREATE TRIGGER daily_export_chunk_immutable BEFORE UPDATE ON daily_export_chunks BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EXPORT_CHUNK'); END;
CREATE TRIGGER daily_export_chunk_sealed_insert BEFORE INSERT ON daily_export_chunks
WHEN EXISTS(SELECT 1 FROM daily_export_artifacts a WHERE a.owner_id=NEW.owner_id AND a.artifact_id=NEW.artifact_id AND a.state='SEALED')
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EXPORT_CHUNK'); END;
CREATE TRIGGER daily_export_pointer_verified BEFORE UPDATE OF rendered_artifact_id ON export_state
WHEN NEW.rendered_artifact_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM daily_export_artifacts a WHERE a.owner_id=NEW.owner_id AND a.artifact_id=NEW.rendered_artifact_id AND a.root_id=NEW.root_namespace AND a.publication_date=NEW.publication_date AND a.state='SEALED')
BEGIN SELECT RAISE(ABORT,'EXPORT_ARTIFACT_NOT_VERIFIED'); END;
CREATE TRIGGER daily_export_pointer_insert_verified BEFORE INSERT ON export_state
WHEN NEW.rendered_artifact_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM daily_export_artifacts a WHERE a.owner_id=NEW.owner_id AND a.artifact_id=NEW.rendered_artifact_id AND a.root_id=NEW.root_namespace AND a.publication_date=NEW.publication_date AND a.state='SEALED')
BEGIN SELECT RAISE(ABORT,'EXPORT_ARTIFACT_NOT_VERIFIED'); END;
CREATE TRIGGER daily_export_artifacts_backup_insert BEFORE INSERT ON daily_export_artifacts WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_export_artifacts_backup_update BEFORE UPDATE ON daily_export_artifacts WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_export_artifacts_backup_delete BEFORE DELETE ON daily_export_artifacts WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_export_chunks_backup_insert BEFORE INSERT ON daily_export_chunks WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_export_chunks_backup_update BEFORE UPDATE ON daily_export_chunks WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER daily_export_chunks_backup_delete BEFORE DELETE ON daily_export_chunks WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
