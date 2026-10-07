ALTER TABLE export_state ADD COLUMN desired_mode TEXT CHECK(desired_mode IN ('COMPACT','FULL'));
UPDATE export_state SET desired_mode=mode;
ALTER TABLE export_state ADD COLUMN settings_revision INTEGER NOT NULL DEFAULT 1 CHECK(settings_revision>=1);
ALTER TABLE export_state ADD COLUMN desired_generation INTEGER NOT NULL DEFAULT 0 CHECK(desired_generation>=0);
ALTER TABLE export_state ADD COLUMN exported_generation INTEGER NOT NULL DEFAULT 0 CHECK(exported_generation>=0);
