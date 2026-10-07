-- Explicit owner-confirmed replacement of a durable analysis that never started.
-- Keep every original state transition; require the new job and owner audit atomically.
DROP TRIGGER jobs_transition_guard;
CREATE TRIGGER jobs_transition_guard BEFORE UPDATE OF state ON jobs
WHEN OLD.state<>NEW.state AND NOT (
  (OLD.state='PENDING' AND NEW.state='LEASED') OR
  (OLD.state='LEASED' AND NEW.state IN ('RUNNING','RETRY_WAIT')) OR
  (OLD.state='RUNNING' AND NEW.state IN ('SUCCEEDED','DEFERRED','RETRY_WAIT','BLOCKED','FAILED')) OR
  (OLD.state IN ('DEFERRED','RETRY_WAIT','BLOCKED','FAILED') AND NEW.state='PENDING' AND COALESCE(OLD.reason_code,'')<>'PROFILE_SUPERSEDED') OR
  (OLD.task_type='ANALYZE' AND OLD.state IN ('PENDING','DEFERRED','RETRY_WAIT') AND NEW.state='FAILED'
    AND NEW.reason_code='PROFILE_SUPERSEDED' AND OLD.lease_owner IS NULL
    AND NEW.fencing_token=OLD.fencing_token+1
    AND NOT EXISTS(SELECT 1 FROM job_attempts a WHERE a.owner_id=OLD.owner_id AND a.job_id=OLD.job_id)
    AND EXISTS(SELECT 1 FROM audit_events e JOIN jobs newer ON newer.owner_id=e.owner_id AND newer.dedup_key=e.correlation_id
      WHERE e.owner_id=OLD.owner_id AND e.actor_id=OLD.owner_id AND e.target_id=OLD.job_id
      AND e.event_type='PENDING_ANALYSIS_REPLACED' AND newer.item_id=OLD.item_id AND newer.state='PENDING'
      AND json_extract(newer.payload_json,'$.snapshot.replaces_pending.job_id')=OLD.job_id
      AND json_extract(newer.payload_json,'$.snapshot.replaces_pending.snapshot_hash')=OLD.profile_revision
      AND json_extract(newer.payload_json,'$.snapshot.replaces_pending.fencing_token')=OLD.fencing_token))
)
BEGIN SELECT RAISE(ABORT,'ILLEGAL_JOB_TRANSITION'); END;
