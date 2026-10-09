-- Preserve the existing Drive identity. Only a batch which first advances all
-- archived receipts to the verified new file hash/revision may advance its state.
DROP TRIGGER retention_report_locked;
CREATE TRIGGER retention_report_locked BEFORE UPDATE ON export_state
WHEN EXISTS(SELECT 1 FROM retention_items t WHERE t.owner_id=OLD.owner_id AND t.root_id=OLD.root_namespace AND t.publication_date=OLD.publication_date AND t.phase IN ('PRUNING','COMPLETE'))
AND (NEW.file_id IS NOT OLD.file_id OR NEW.full_file_hash IS NOT OLD.full_file_hash OR NEW.revision!=OLD.revision)
AND (NEW.file_id IS NOT OLD.file_id OR EXISTS(SELECT 1 FROM retention_items t WHERE t.owner_id=OLD.owner_id AND t.root_id=OLD.root_namespace AND t.publication_date=OLD.publication_date AND t.phase IN ('PRUNING','COMPLETE') AND (t.phase='PRUNING' OR t.file_id IS NOT NEW.file_id OR t.file_hash IS NOT NEW.full_file_hash OR t.export_revision!=NEW.revision)))
BEGIN SELECT RAISE(ABORT,'ARCHIVED_REPORT_REQUIRES_RECOVERY'); END;
