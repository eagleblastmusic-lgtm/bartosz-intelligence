CREATE UNIQUE INDEX scans_owner_identity ON discovery_scans(owner_id,scan_id);
ALTER TABLE discovery_scans ADD COLUMN staged_page_json TEXT CHECK(staged_page_json IS NULL OR json_valid(staged_page_json));
ALTER TABLE discovery_scans ADD COLUMN staged_next_cursor TEXT;
ALTER TABLE discovery_scans ADD COLUMN staged_page_hash TEXT;
ALTER TABLE discovery_scans ADD COLUMN page_offset INTEGER NOT NULL DEFAULT 0 CHECK(page_offset>=0);
CREATE TABLE discovery_scan_members (
  owner_id TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  FOREIGN KEY(owner_id,scan_id) REFERENCES discovery_scans(owner_id,scan_id),
  FOREIGN KEY(owner_id,item_id) REFERENCES items(owner_id,item_id),
  PRIMARY KEY(owner_id,scan_id,item_id)
);
