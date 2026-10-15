-- Replay resets only the availability-attempt epoch; immutable job inputs and
-- all historical attempts remain unchanged.
ALTER TABLE jobs ADD COLUMN caption_retry_after_fence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN caption_retry_origin_at TEXT;
