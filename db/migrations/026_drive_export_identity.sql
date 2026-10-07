ALTER TABLE export_state ADD COLUMN connection_id TEXT;
ALTER TABLE export_state ADD COLUMN reserved_remote_id TEXT;
ALTER TABLE export_state ADD COLUMN lease_owner TEXT;
ALTER TABLE export_state ADD COLUMN lease_until TEXT;
ALTER TABLE export_state ADD COLUMN fencing_token INTEGER NOT NULL DEFAULT 0 CHECK(fencing_token>=0);
CREATE UNIQUE INDEX drive_export_day_identity ON export_state(owner_id,root_namespace,publication_date,timezone) WHERE destination_key GLOB 'drive:*';
CREATE UNIQUE INDEX drive_export_reserved_identity ON export_state(owner_id,reserved_remote_id) WHERE reserved_remote_id IS NOT NULL;
CREATE TRIGGER drive_export_insert_identity BEFORE INSERT ON export_state
WHEN NEW.destination_key GLOB 'drive:*' AND (NEW.destination_key!='drive:'||NEW.root_namespace OR NEW.timezone!='Europe/Warsaw' OR NEW.connection_id IS NULL OR (NEW.file_id IS NOT NULL AND (NEW.reserved_remote_id IS NULL OR NEW.file_id!=NEW.reserved_remote_id)))
BEGIN SELECT RAISE(ABORT,'EXPORT_IDENTITY_MISMATCH'); END;
CREATE TRIGGER drive_export_reserved_immutable BEFORE UPDATE OF reserved_remote_id ON export_state
WHEN OLD.reserved_remote_id IS NOT NULL AND NEW.reserved_remote_id IS NOT OLD.reserved_remote_id
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EXPORT_RESERVED_ID'); END;
CREATE TRIGGER drive_export_file_immutable BEFORE UPDATE OF file_id ON export_state
WHEN OLD.file_id IS NOT NULL AND NEW.file_id IS NOT OLD.file_id
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EXPORT_FILE_ID'); END;
CREATE TRIGGER drive_export_file_reserved_match BEFORE UPDATE OF file_id ON export_state
WHEN NEW.destination_key GLOB 'drive:*' AND NEW.file_id IS NOT NULL AND (NEW.reserved_remote_id IS NULL OR NEW.file_id!=NEW.reserved_remote_id)
BEGIN SELECT RAISE(ABORT,'EXPORT_RESERVED_ID_MISMATCH'); END;
CREATE TRIGGER drive_export_mapping_immutable BEFORE UPDATE OF root_namespace,destination_key,publication_date,timezone ON export_state
WHEN OLD.destination_key GLOB 'drive:*' AND (NEW.root_namespace!=OLD.root_namespace OR NEW.destination_key!=OLD.destination_key OR NEW.publication_date!=OLD.publication_date OR NEW.timezone!=OLD.timezone)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EXPORT_MAPPING'); END;
