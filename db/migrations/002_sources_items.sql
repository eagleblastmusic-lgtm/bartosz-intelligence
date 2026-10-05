CREATE TABLE sources (
  source_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owner_users(owner_id),
  namespace TEXT NOT NULL,
  external_id TEXT NOT NULL,
  canonical_locator TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  profile_revision TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  last_complete_window_end TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT,
  due_at TEXT NOT NULL,
  access_state TEXT NOT NULL DEFAULT 'PUBLIC' CHECK (access_state IN ('PUBLIC','UNKNOWN','RESTRICTED','REMOVED')),
  restriction_reason TEXT,
  ai_processing_allowed INTEGER NOT NULL DEFAULT 1 CHECK (ai_processing_allowed IN (0,1)),
  UNIQUE(owner_id, namespace, external_id),
  UNIQUE(owner_id, source_id)
);
CREATE INDEX sources_due ON sources(enabled, due_at, source_id);
CREATE INDEX sources_owner_listing ON sources(owner_id, activated_at, source_id);
CREATE TABLE channels (
  source_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  youtube_channel_id TEXT NOT NULL,
  uploads_playlist_id TEXT NOT NULL,
  handle_snapshot TEXT,
  title TEXT NOT NULL,
  FOREIGN KEY(owner_id,source_id) REFERENCES sources(owner_id,source_id),
  UNIQUE(owner_id,youtube_channel_id)
);
CREATE TABLE items (
  item_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  external_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  published_at TEXT,
  publication_provenance TEXT NOT NULL,
  current_revision_id TEXT,
  discovered_at TEXT NOT NULL,
  availability TEXT NOT NULL CHECK (availability IN ('PUBLIC','PRIVATE','DELETED','UNKNOWN','LIVE')),
  FOREIGN KEY(owner_id,source_id) REFERENCES sources(owner_id,source_id),
  FOREIGN KEY(owner_id,item_id,current_revision_id) REFERENCES item_revisions(owner_id,item_id,revision_id),
  UNIQUE(owner_id,namespace,external_id),
  UNIQUE(owner_id,item_id)
);
CREATE INDEX items_publication ON items(owner_id,published_at,item_id);
CREATE INDEX items_discovery ON items(owner_id,discovered_at,item_id);
CREATE INDEX items_source ON items(owner_id,source_id,item_id);
CREATE TABLE item_revisions (
  revision_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  metadata_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  fetched_at TEXT NOT NULL,
  availability TEXT NOT NULL CHECK (availability IN ('PUBLIC','PRIVATE','DELETED','UNKNOWN','LIVE')),
  FOREIGN KEY(owner_id,item_id) REFERENCES items(owner_id,item_id),
  UNIQUE(owner_id,item_id,metadata_hash),
  UNIQUE(owner_id,item_id,revision_id)
);
CREATE TRIGGER item_revisions_no_update BEFORE UPDATE ON item_revisions
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_ITEM_REVISION'); END;
