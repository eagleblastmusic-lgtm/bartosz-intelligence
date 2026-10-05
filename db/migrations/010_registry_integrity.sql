CREATE TRIGGER schema_versions_no_delete BEFORE DELETE ON schema_versions
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SCHEMA'); END;
CREATE TRIGGER prompt_versions_no_delete BEFORE DELETE ON prompt_versions
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROMPT'); END;
CREATE TRIGGER prompt_identity_immutable BEFORE UPDATE OF prompt_id,owner_id,created_at ON prompt_versions
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROMPT'); END;
