CREATE TABLE semantic_profile_versions (
 owner_id TEXT NOT NULL REFERENCES owner_users(owner_id), profile_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 config_json TEXT NOT NULL CHECK(json_valid(config_json)), config_hash TEXT NOT NULL CHECK(length(config_hash)=64),
 wire_schema_id TEXT NOT NULL, wire_schema_version TEXT NOT NULL,
 prompt_id TEXT NOT NULL, prompt_version INTEGER NOT NULL,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
 authored_by TEXT NOT NULL CHECK(authored_by=owner_id), reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000), created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,profile_id,revision),
 FOREIGN KEY(wire_schema_id,wire_schema_version) REFERENCES schema_versions(schema_id,version),
 FOREIGN KEY(owner_id,prompt_id,prompt_version) REFERENCES prompt_versions(owner_id,prompt_id,version)
);
CREATE TRIGGER semantic_profile_no_update BEFORE UPDATE ON semantic_profile_versions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SEMANTIC_PROFILE'); END;
CREATE TRIGGER semantic_profile_no_delete BEFORE DELETE ON semantic_profile_versions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SEMANTIC_PROFILE'); END;
CREATE TRIGGER semantic_profile_backup_insert BEFORE INSERT ON semantic_profile_versions WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER projection_invalidate_semantic_profile_insert AFTER INSERT ON semantic_profile_versions BEGIN INSERT INTO change_log(owner_id,component,target_id,event_type,created_at) VALUES(NEW.owner_id,'registry',NEW.profile_id,'SEMANTIC_PROFILE_VERSION_CREATED',NEW.created_at); END;
