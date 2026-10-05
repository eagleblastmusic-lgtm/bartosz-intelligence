CREATE TABLE entities (
 owner_id TEXT NOT NULL REFERENCES owner_users(owner_id), entity_id TEXT NOT NULL,
 label TEXT NOT NULL, entity_type TEXT NOT NULL CHECK(entity_type IN ('PERSON','ORG','TOOL','MODEL','PRODUCT','TOPIC','PLACE','OTHER')),
 resolution TEXT NOT NULL CHECK(resolution IN ('APPROVED_ALIAS','UNRESOLVED_LITERAL','AMBIGUOUS_LITERAL')),
 created_at TEXT NOT NULL, PRIMARY KEY(owner_id,entity_id)
);
CREATE TABLE entity_aliases (
 owner_id TEXT NOT NULL, alias_id TEXT NOT NULL, entity_id TEXT NOT NULL,
 literal TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,alias_id), FOREIGN KEY(owner_id,entity_id) REFERENCES entities(owner_id,entity_id)
);
CREATE INDEX entity_alias_literal ON entity_aliases(owner_id,literal);
CREATE TABLE evidence (
 owner_id TEXT NOT NULL, evidence_id TEXT NOT NULL, item_id TEXT NOT NULL,
 source_artifact_id TEXT NOT NULL, source_hash TEXT NOT NULL CHECK(length(source_hash)=64),
 source_start INTEGER NOT NULL CHECK(source_start>=0), source_end INTEGER NOT NULL CHECK(source_end>source_start),
 quote_hash TEXT NOT NULL CHECK(length(quote_hash)=64), segment_ids_json TEXT NOT NULL CHECK(json_valid(segment_ids_json)),
 anchor_snapshot_json TEXT NOT NULL CHECK(json_valid(anchor_snapshot_json)),
 start_ms INTEGER, end_ms INTEGER, timestamp_precision TEXT NOT NULL CHECK(timestamp_precision IN ('CUE','WORD','ESTIMATED','NONE')),
 timestamp_url TEXT, created_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,evidence_id),
 FOREIGN KEY(owner_id,item_id,source_artifact_id) REFERENCES artifacts(owner_id,item_id,artifact_id),
 CHECK((timestamp_precision='NONE' AND start_ms IS NULL AND end_ms IS NULL AND timestamp_url IS NULL) OR (timestamp_precision!='NONE' AND start_ms IS NOT NULL AND end_ms IS NOT NULL AND start_ms>=0 AND end_ms>=start_ms))
);
CREATE TABLE analysis_evidence (
 owner_id TEXT NOT NULL, run_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
 PRIMARY KEY(owner_id,run_id,evidence_id),
 FOREIGN KEY(owner_id,run_id) REFERENCES analysis_runs(owner_id,run_id),
 FOREIGN KEY(owner_id,evidence_id) REFERENCES evidence(owner_id,evidence_id)
);
CREATE TABLE observations (
 owner_id TEXT NOT NULL, observation_id TEXT NOT NULL, run_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('CLAIM','STANCE','PREDICTION','USAGE','RECOMMENDATION','UNCERTAINTY','CONTRADICTION')),
 row_json TEXT NOT NULL CHECK(json_valid(row_json)), row_hash TEXT NOT NULL CHECK(length(row_hash)=64),
 recorded_at TEXT NOT NULL, PRIMARY KEY(owner_id,observation_id),
 FOREIGN KEY(owner_id,run_id) REFERENCES analysis_runs(owner_id,run_id),
 CHECK(json_extract(row_json,'$.observation_id') IS NOT NULL AND json_extract(row_json,'$.kind') IS NOT NULL AND json_extract(row_json,'$.observation_id')=observation_id AND json_extract(row_json,'$.kind')=kind)
);
CREATE TABLE observation_evidence (
 owner_id TEXT NOT NULL, observation_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
 PRIMARY KEY(owner_id,observation_id,evidence_id),
 FOREIGN KEY(owner_id,observation_id) REFERENCES observations(owner_id,observation_id),
 FOREIGN KEY(owner_id,evidence_id) REFERENCES evidence(owner_id,evidence_id)
);
CREATE TABLE observation_entities (
 owner_id TEXT NOT NULL, observation_id TEXT NOT NULL, entity_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('SUBJECT','TARGET','MENTION')),
 PRIMARY KEY(owner_id,observation_id,entity_id,role),
 FOREIGN KEY(owner_id,observation_id) REFERENCES observations(owner_id,observation_id),
 FOREIGN KEY(owner_id,entity_id) REFERENCES entities(owner_id,entity_id)
);
CREATE TRIGGER entities_no_update BEFORE UPDATE ON entities BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ENTITY'); END;
CREATE TRIGGER entities_no_delete BEFORE DELETE ON entities BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ENTITY'); END;
CREATE TRIGGER aliases_no_update BEFORE UPDATE ON entity_aliases BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ALIAS'); END;
CREATE TRIGGER aliases_no_delete BEFORE DELETE ON entity_aliases BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ALIAS'); END;
CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EVIDENCE'); END;
CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EVIDENCE'); END;
CREATE TRIGGER analysis_evidence_no_update BEFORE UPDATE ON analysis_evidence BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RUN_EVIDENCE'); END;
CREATE TRIGGER analysis_evidence_no_delete BEFORE DELETE ON analysis_evidence BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RUN_EVIDENCE'); END;
CREATE TRIGGER observations_no_update BEFORE UPDATE ON observations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OBSERVATION'); END;
CREATE TRIGGER observations_no_delete BEFORE DELETE ON observations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OBSERVATION'); END;
CREATE TRIGGER observation_evidence_no_update BEFORE UPDATE ON observation_evidence BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OBSERVATION_JOIN'); END;
CREATE TRIGGER observation_evidence_no_delete BEFORE DELETE ON observation_evidence BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OBSERVATION_JOIN'); END;
CREATE TRIGGER observation_entities_no_update BEFORE UPDATE ON observation_entities BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OBSERVATION_JOIN'); END;
CREATE TRIGGER observation_entities_no_delete BEFORE DELETE ON observation_entities BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OBSERVATION_JOIN'); END;
CREATE TRIGGER entities_backup_insert BEFORE INSERT ON entities WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER entity_aliases_backup_insert BEFORE INSERT ON entity_aliases WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER evidence_backup_insert BEFORE INSERT ON evidence WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER analysis_evidence_backup_insert BEFORE INSERT ON analysis_evidence WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER observations_backup_insert BEFORE INSERT ON observations WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER observation_evidence_backup_insert BEFORE INSERT ON observation_evidence WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER observation_entities_backup_insert BEFORE INSERT ON observation_entities WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
