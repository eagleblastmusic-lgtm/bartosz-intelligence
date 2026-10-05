CREATE TABLE artifacts (
 artifact_id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 item_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('RAW','SOURCE_ORIGINAL','NORMALIZED','PL_HELPER','ANALYSIS_CANDIDATE','SEGMENT_MAP','OFFSET_MAP')),
 content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
 byte_size INTEGER NOT NULL CHECK(byte_size>=0),
 chunk_count INTEGER NOT NULL CHECK(chunk_count>=1 AND chunk_count<=1024),
 schema_version TEXT NOT NULL,
 producer_version TEXT NOT NULL,
 provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
 original_ref TEXT,
 state TEXT NOT NULL DEFAULT 'UPLOADING' CHECK(state IN ('UPLOADING','VERIFIED')),
 manifest_hash TEXT,
 created_at TEXT NOT NULL,
 verified_at TEXT,
 FOREIGN KEY(owner_id,item_id) REFERENCES items(owner_id,item_id),
 FOREIGN KEY(owner_id,item_id,original_ref) REFERENCES artifacts(owner_id,item_id,artifact_id),
 UNIQUE(owner_id,item_id,artifact_id),
 UNIQUE(owner_id,item_id,kind,content_hash,producer_version)
);
CREATE INDEX artifact_item ON artifacts(owner_id,item_id,kind,created_at);
CREATE TABLE artifact_chunks (
 owner_id TEXT NOT NULL,
 item_id TEXT NOT NULL,
 artifact_id TEXT NOT NULL,
 chunk_index INTEGER NOT NULL CHECK(chunk_index>=0 AND chunk_index<1024),
 byte_start INTEGER NOT NULL CHECK(byte_start>=0),
 byte_size INTEGER NOT NULL CHECK(byte_size>=0 AND byte_size<=32768),
 byte_hash TEXT NOT NULL CHECK(length(byte_hash)=64),
 storage_ref TEXT NOT NULL,
 body_base64 TEXT NOT NULL CHECK(length(body_base64)<=43692),
 FOREIGN KEY(owner_id,item_id,artifact_id) REFERENCES artifacts(owner_id,item_id,artifact_id),
 PRIMARY KEY(owner_id,artifact_id,chunk_index)
);
CREATE TABLE transcript_representations (
 representation_id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 item_id TEXT NOT NULL,
 artifact_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('SOURCE_AUTHORITY','PL_HELPER')),
 language_code TEXT NOT NULL,
 track_kind TEXT NOT NULL CHECK(track_kind IN ('MANUAL','GENERATED','TRANSLATED','STT','UNKNOWN')),
 provider_id TEXT NOT NULL,
 provider_version TEXT NOT NULL,
 normalizer_version TEXT,
 original_ref TEXT,
 flags_json TEXT NOT NULL CHECK(json_valid(flags_json)),
 created_at TEXT NOT NULL,
 FOREIGN KEY(owner_id,item_id,artifact_id) REFERENCES artifacts(owner_id,item_id,artifact_id),
 FOREIGN KEY(owner_id,item_id,original_ref) REFERENCES artifacts(owner_id,item_id,artifact_id),
 UNIQUE(owner_id,artifact_id,role)
);
CREATE TRIGGER artifact_header_immutable BEFORE UPDATE OF artifact_id,owner_id,item_id,kind,content_hash,byte_size,chunk_count,schema_version,producer_version,provenance_json,original_ref,created_at ON artifacts
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARTIFACT'); END;
CREATE TRIGGER artifact_closed_immutable BEFORE UPDATE ON artifacts WHEN OLD.state='VERIFIED'
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARTIFACT'); END;
CREATE TRIGGER artifact_no_delete BEFORE DELETE ON artifacts
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARTIFACT'); END;
CREATE TRIGGER artifact_chunks_no_update BEFORE UPDATE ON artifact_chunks
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARTIFACT_CHUNK'); END;
CREATE TRIGGER artifact_chunks_no_delete BEFORE DELETE ON artifact_chunks
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARTIFACT_CHUNK'); END;
CREATE TRIGGER representation_no_update BEFORE UPDATE ON transcript_representations
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REPRESENTATION'); END;
CREATE TRIGGER representation_no_delete BEFORE DELETE ON transcript_representations
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REPRESENTATION'); END;
CREATE TRIGGER representation_verified_source BEFORE INSERT ON transcript_representations WHEN NOT EXISTS(SELECT 1 FROM artifacts WHERE owner_id=NEW.owner_id AND item_id=NEW.item_id AND artifact_id=NEW.artifact_id AND state='VERIFIED')
BEGIN SELECT RAISE(ABORT,'ARTIFACT_NOT_VERIFIED'); END;
CREATE TRIGGER artifacts_backup_insert BEFORE INSERT ON artifacts WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER artifacts_backup_update BEFORE UPDATE ON artifacts WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER artifact_chunks_backup_insert BEFORE INSERT ON artifact_chunks WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER transcript_representations_backup_insert BEFORE INSERT ON transcript_representations WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
