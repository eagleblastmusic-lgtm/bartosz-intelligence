-- Derived views share the existing change_log; no Daily content store exists.
-- Both publication dates remain explicit for later export/cache invalidation.
CREATE TRIGGER projection_invalidate_source_insert AFTER INSERT ON sources
BEGIN INSERT INTO change_log(owner_id,component,target_id,event_type,created_at) VALUES(NEW.owner_id,'sources',NEW.source_id,'SOURCE_ADDED',NEW.activated_at); END;
CREATE TRIGGER projection_invalidate_item_insert AFTER INSERT ON items
BEGIN INSERT INTO change_log(owner_id,component,target_id,event_type,created_at) VALUES(NEW.owner_id,'items',NEW.item_id,'ITEM_DISCOVERED',NEW.discovered_at); END;
CREATE TRIGGER projection_invalidate_item_update AFTER UPDATE OF current_revision_id,published_at,availability ON items WHEN OLD.current_revision_id IS NOT NEW.current_revision_id OR OLD.published_at IS NOT NEW.published_at OR OLD.availability IS NOT NEW.availability
BEGIN INSERT INTO change_log(owner_id,component,target_id,event_type,created_at) VALUES(NEW.owner_id,'items',json_object('item_id',NEW.item_id,'old_published_at',OLD.published_at,'new_published_at',NEW.published_at),'ITEM_METADATA_CHANGED',strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
CREATE TRIGGER projection_invalidate_job_insert AFTER INSERT ON jobs WHEN NEW.item_id IS NOT NULL
BEGIN INSERT INTO change_log(owner_id,component,target_id,event_type,created_at) VALUES(NEW.owner_id,'jobs',NEW.item_id,'JOB_CREATED',NEW.created_at); END;
CREATE TRIGGER projection_invalidate_job_update AFTER UPDATE OF state,reason_code,due_at ON jobs WHEN NEW.item_id IS NOT NULL AND (OLD.state IS NOT NEW.state OR OLD.reason_code IS NOT NEW.reason_code OR OLD.due_at IS NOT NEW.due_at)
BEGIN INSERT INTO change_log(owner_id,component,target_id,event_type,created_at) VALUES(NEW.owner_id,'jobs',NEW.item_id,'JOB_STATUS_CHANGED',NEW.updated_at); END;
CREATE TRIGGER projection_invalidate_selection_insert AFTER INSERT ON active_analysis_selections
BEGIN INSERT INTO change_log(owner_id,component,target_id,event_type,created_at) VALUES(NEW.owner_id,'selection',NEW.item_id,'SELECTION_CHANGED',strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
CREATE TRIGGER projection_invalidate_selection_update AFTER UPDATE ON active_analysis_selections WHEN OLD.selection_revision IS NOT NEW.selection_revision OR OLD.accepted_run_id IS NOT NEW.accepted_run_id OR OLD.requested_run_id IS NOT NEW.requested_run_id
BEGIN INSERT INTO change_log(owner_id,component,target_id,event_type,created_at) VALUES(NEW.owner_id,'selection',NEW.item_id,'SELECTION_CHANGED',strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
CREATE TRIGGER projection_invalidate_source_update AFTER UPDATE OF enabled,window_start,last_complete_window_end,access_state,ai_processing_allowed ON sources WHEN OLD.enabled IS NOT NEW.enabled OR OLD.window_start IS NOT NEW.window_start OR OLD.last_complete_window_end IS NOT NEW.last_complete_window_end OR OLD.access_state IS NOT NEW.access_state OR OLD.ai_processing_allowed IS NOT NEW.ai_processing_allowed
BEGIN INSERT INTO change_log(owner_id,component,target_id,event_type,created_at) VALUES(NEW.owner_id,'sources',NEW.source_id,'SOURCE_COVERAGE_CHANGED',strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
CREATE TRIGGER projection_invalidate_scan_insert AFTER INSERT ON discovery_scans
BEGIN INSERT INTO change_log(owner_id,component,target_id,event_type,created_at) VALUES(NEW.owner_id,'discovery',NEW.scan_id,'DISCOVERY_STARTED',NEW.started_at); END;
CREATE TRIGGER projection_invalidate_scan_update AFTER UPDATE OF coverage,window_start,window_end ON discovery_scans WHEN OLD.coverage IS NOT NEW.coverage OR OLD.window_start IS NOT NEW.window_start OR OLD.window_end IS NOT NEW.window_end
BEGIN INSERT INTO change_log(owner_id,component,target_id,event_type,created_at) VALUES(NEW.owner_id,'discovery',NEW.scan_id,'DISCOVERY_COVERAGE_CHANGED',strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
