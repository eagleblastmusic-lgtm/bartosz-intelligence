CREATE TABLE export_dirty_cursor (
  owner_id TEXT PRIMARY KEY REFERENCES owner_users(owner_id),
  processed_seq INTEGER NOT NULL DEFAULT 0 CHECK(processed_seq>=0)
);
ALTER TABLE export_state ADD COLUMN first_dirty_at TEXT;
ALTER TABLE export_state ADD COLUMN last_material_event_at TEXT;
CREATE INDEX drive_dirty_fair_queue ON export_state(owner_id,first_dirty_at,publication_date) WHERE destination_key GLOB 'drive:*';
CREATE TRIGGER export_dirty_cursor_backup_insert BEFORE INSERT ON export_dirty_cursor WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER export_dirty_cursor_backup_update BEFORE UPDATE ON export_dirty_cursor WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER export_dirty_cursor_backup_delete BEFORE DELETE ON export_dirty_cursor WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
