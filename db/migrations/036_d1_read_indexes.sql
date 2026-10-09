-- Index-only upgrade: canonical tables, data and backup projections unchanged.
CREATE INDEX transcript_admission_errors ON job_attempts(owner_id,error_code,finished_at,job_id)
WHERE error_code IN ('LOCAL_YTDLP_IP_BLOCKED','LOCAL_YTDLP_PARSER_CHANGED');
CREATE INDEX capacity_accepted_item ON analysis_runs(owner_id,item_id,created_at DESC,run_id DESC)
WHERE state='ACCEPTED';
CREATE INDEX metadata_refresh_active ON jobs(owner_id,source_id)
WHERE task_type='RECONCILE' AND json_extract(payload_json,'$.mode')='REFRESH'
AND state IN ('PENDING','LEASED','RUNNING','DEFERRED','RETRY_WAIT');
CREATE INDEX metadata_revision_due ON item_revisions(fetched_at,owner_id,item_id,revision_id);
CREATE INDEX metadata_observation_item ON discovery_scan_members(owner_id,item_id,scan_id);
