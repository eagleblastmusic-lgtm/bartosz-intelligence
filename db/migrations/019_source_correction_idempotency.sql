CREATE UNIQUE INDEX source_correction_request_nonce ON jobs(owner_id,explicit_run_nonce)
WHERE task_type='NORMALIZE' AND profile_revision='owner-source-correction:1';
