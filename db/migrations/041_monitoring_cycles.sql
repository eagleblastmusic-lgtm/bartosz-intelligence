-- Durable Warsaw slots; scans retain their existing lease/fencing contract.
CREATE TABLE monitoring_cycles (
 cycle_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner_users(owner_id),
 local_date TEXT NOT NULL, slot TEXT NOT NULL,
 members_json TEXT NOT NULL CHECK(json_valid(members_json)),
 cursor INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL,
 completed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'ENROLLING' CHECK(state IN ('ENROLLING','RUNNING','COMPLETE','FAILED')),
 started_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT,
 UNIQUE(owner_id,local_date,slot), CHECK(cursor>=0 AND cursor<=total)
);
CREATE INDEX monitoring_cycle_active ON monitoring_cycles(state,started_at,cycle_id);
ALTER TABLE discovery_scans ADD COLUMN monitoring_cycle_id TEXT REFERENCES monitoring_cycles(cycle_id);
CREATE INDEX monitoring_cycle_scans ON discovery_scans(monitoring_cycle_id,job_id);
CREATE TRIGGER monitoring_cycles_backup_insert BEFORE INSERT ON monitoring_cycles WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER monitoring_cycles_backup_update BEFORE UPDATE ON monitoring_cycles WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER monitoring_cycles_backup_delete BEFORE DELETE ON monitoring_cycles WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
