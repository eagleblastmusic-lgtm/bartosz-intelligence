CREATE TABLE schema_versions (
  schema_id TEXT NOT NULL,
  version TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  schema_json TEXT NOT NULL CHECK(json_valid(schema_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(schema_id,version)
);
CREATE TRIGGER schema_versions_no_update BEFORE UPDATE ON schema_versions
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SCHEMA'); END;
CREATE TABLE prompt_versions (
  prompt_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES owner_users(owner_id),
  version INTEGER NOT NULL CHECK(version>0),
  prompt_hash TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  bundle_json TEXT NOT NULL CHECK(json_valid(bundle_json)),
  status TEXT NOT NULL CHECK(status IN ('DRAFT','TESTED','PUBLISHED')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,prompt_id,version)
);
CREATE TRIGGER prompt_content_immutable BEFORE UPDATE OF prompt_hash,prompt_text,bundle_json,version ON prompt_versions
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROMPT'); END;
CREATE TABLE analysis_runs (
  run_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  item_id TEXT,
  job_id TEXT NOT NULL,
  input_snapshot_json TEXT NOT NULL CHECK(json_valid(input_snapshot_json)),
  profile_snapshot_json TEXT NOT NULL CHECK(json_valid(profile_snapshot_json)),
  prompt_snapshot_json TEXT CHECK(prompt_snapshot_json IS NULL OR json_valid(prompt_snapshot_json)),
  wire_schema_version TEXT,
  canonical_schema_version TEXT,
  enrichment_version TEXT,
  routing_snapshot_json TEXT NOT NULL CHECK(json_valid(routing_snapshot_json)),
  state TEXT NOT NULL CHECK(state IN ('CANDIDATE','ACCEPTED','REJECTED')),
  candidate_hash TEXT,
  validation_outcome TEXT,
  outcome_json TEXT CHECK(outcome_json IS NULL OR json_valid(outcome_json)),
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  FOREIGN KEY(owner_id,item_id) REFERENCES items(owner_id,item_id),
  FOREIGN KEY(owner_id,job_id) REFERENCES jobs(owner_id,job_id),
  UNIQUE(owner_id,run_id),
  UNIQUE(owner_id,job_id,run_id)
);
CREATE TRIGGER runs_snapshot_immutable BEFORE UPDATE OF input_snapshot_json,profile_snapshot_json,prompt_snapshot_json,wire_schema_version,canonical_schema_version,enrichment_version,routing_snapshot_json ON analysis_runs
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RUN_SNAPSHOT'); END;
CREATE TRIGGER runs_accepted_immutable BEFORE UPDATE ON analysis_runs WHEN OLD.state='ACCEPTED'
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ACCEPTED_RUN'); END;
CREATE TABLE active_analysis_selections (
  owner_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  requested_run_id TEXT NOT NULL,
  selection_revision INTEGER NOT NULL CHECK(selection_revision>0),
  accepted_run_id TEXT,
  FOREIGN KEY(owner_id,item_id) REFERENCES items(owner_id,item_id),
  FOREIGN KEY(owner_id,requested_run_id) REFERENCES analysis_runs(owner_id,run_id),
  FOREIGN KEY(owner_id,accepted_run_id) REFERENCES analysis_runs(owner_id,run_id),
  PRIMARY KEY(owner_id,item_id)
);
CREATE TABLE export_state (
  owner_id TEXT NOT NULL REFERENCES owner_users(owner_id),
  publication_date TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Europe/Warsaw',
  destination_key TEXT NOT NULL,
  root_namespace TEXT NOT NULL,
  dirty_seq INTEGER NOT NULL DEFAULT 0,
  exported_seq INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'COMPACT' CHECK(mode IN ('COMPACT','FULL')),
  file_id TEXT,
  body_hash TEXT,
  full_file_hash TEXT,
  PRIMARY KEY(owner_id,publication_date,timezone,destination_key)
);
