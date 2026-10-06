-- Existing items_publication and active_analysis_selections PK are reused.
CREATE INDEX items_source_publication ON items(owner_id,source_id,published_at,item_id);
CREATE INDEX jobs_item_recent ON jobs(owner_id,item_id,created_at DESC,job_id DESC);
CREATE INDEX observations_run_kind ON observations(owner_id,run_id,kind,observation_id);
CREATE INDEX evidence_item ON evidence(owner_id,item_id,evidence_id);
CREATE INDEX discovery_source_window ON discovery_scans(owner_id,source_id,window_start,window_end,coverage);
