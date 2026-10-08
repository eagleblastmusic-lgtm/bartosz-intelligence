ALTER TABLE export_state ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count>=0);
ALTER TABLE export_state ADD COLUMN next_retry_at TEXT;
ALTER TABLE export_state ADD COLUMN paused_reason TEXT;
ALTER TABLE export_state ADD COLUMN last_failure_code TEXT;
