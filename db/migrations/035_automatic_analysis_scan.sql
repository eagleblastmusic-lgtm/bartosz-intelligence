-- Bounded source preparation and duplicate detection must not scan all jobs.
CREATE INDEX automatic_source_scan ON analysis_runs(owner_id,state,accepted_at,run_id);
CREATE INDEX automatic_analysis_source ON jobs(owner_id,json_extract(payload_json,'$.snapshot.source.run_id')) WHERE task_type='ANALYZE' AND json_extract(payload_json,'$.snapshot.settings.mode')='PRODUCTION';
