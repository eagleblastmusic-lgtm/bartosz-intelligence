ALTER TABLE backup_snapshots ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1 CHECK(format_version IN (1,2));
CREATE TRIGGER backup_snapshot_format_immutable BEFORE UPDATE OF format_version ON backup_snapshots
WHEN NEW.format_version!=OLD.format_version
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_BACKUP_FORMAT'); END;
