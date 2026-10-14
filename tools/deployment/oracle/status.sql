-- Odczyt przez właściciela z dostępem D1. Ustawić właściwy worker_id i owner_id.
SELECT worker_id,runtime,heartbeat_at,online_until FROM worker_sessions
WHERE worker_id='UZUPELNIJ_WORKER_ID' AND owner_id='UZUPELNIJ_OWNER_ID';
SELECT j.job_id,j.state,j.updated_at,r.accepted_at,r.run_id,
json_extract(r.outcome_json,'$.source_artifact_id') AS source_artifact_id
FROM jobs j LEFT JOIN analysis_runs r ON r.owner_id=j.owner_id AND r.job_id=j.job_id AND r.state='ACCEPTED'
WHERE j.owner_id='UZUPELNIJ_OWNER_ID' AND j.task_type='FETCH_TRANSCRIPT' AND j.state='SUCCEEDED'
ORDER BY j.updated_at DESC LIMIT 1;
SELECT state,COUNT(*) AS jobs,MIN(due_at) AS oldest_due_at FROM jobs
WHERE owner_id='UZUPELNIJ_OWNER_ID' AND task_type='FETCH_TRANSCRIPT' GROUP BY state;
SELECT job_id,lease_owner,lease_until,fencing_token,attempt_count,reason_code FROM jobs
WHERE owner_id='UZUPELNIJ_OWNER_ID' AND task_type='FETCH_TRANSCRIPT' AND state IN ('LEASED','RUNNING','BLOCKED')
ORDER BY updated_at DESC LIMIT 10;
