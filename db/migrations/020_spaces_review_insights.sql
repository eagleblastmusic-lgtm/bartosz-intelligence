CREATE TABLE spaces (
 owner_id TEXT NOT NULL REFERENCES owner_users(owner_id), space_id TEXT NOT NULL,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120), active INTEGER NOT NULL CHECK(active IN (0,1)),
 revision INTEGER NOT NULL CHECK(revision>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,space_id)
);
CREATE TABLE item_spaces (
 owner_id TEXT NOT NULL, item_id TEXT NOT NULL, space_id TEXT NOT NULL,
 active INTEGER NOT NULL CHECK(active IN (0,1)), revision INTEGER NOT NULL CHECK(revision>0), updated_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,item_id,space_id),
 FOREIGN KEY(owner_id,item_id) REFERENCES items(owner_id,item_id),
 FOREIGN KEY(owner_id,space_id) REFERENCES spaces(owner_id,space_id)
);
CREATE INDEX space_members ON item_spaces(owner_id,space_id,active,item_id);
CREATE TABLE review_state (
 owner_id TEXT NOT NULL, item_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 saved INTEGER NOT NULL CHECK(saved IN (0,1)), last_opened TEXT, read_at TEXT, reviewed_run_id TEXT, updated_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,item_id), FOREIGN KEY(owner_id,item_id) REFERENCES items(owner_id,item_id),
 FOREIGN KEY(owner_id,reviewed_run_id) REFERENCES analysis_runs(owner_id,run_id)
);
CREATE TRIGGER review_run_insert BEFORE INSERT ON review_state WHEN NEW.reviewed_run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM analysis_runs WHERE owner_id=NEW.owner_id AND item_id=NEW.item_id AND run_id=NEW.reviewed_run_id AND state='ACCEPTED') BEGIN SELECT RAISE(ABORT,'INVALID_REVIEWED_RUN'); END;
CREATE TRIGGER review_run_update BEFORE UPDATE ON review_state WHEN NEW.reviewed_run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM analysis_runs WHERE owner_id=NEW.owner_id AND item_id=NEW.item_id AND run_id=NEW.reviewed_run_id AND state='ACCEPTED') BEGIN SELECT RAISE(ABORT,'INVALID_REVIEWED_RUN'); END;
CREATE TABLE insights (
 owner_id TEXT NOT NULL REFERENCES owner_users(owner_id), insight_id TEXT NOT NULL,
 item_id TEXT NOT NULL, text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 20000),
 authored_by TEXT NOT NULL CHECK(authored_by=owner_id), active INTEGER NOT NULL CHECK(active IN (0,1)),
 revision INTEGER NOT NULL CHECK(revision>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,insight_id), FOREIGN KEY(owner_id,item_id) REFERENCES items(owner_id,item_id)
);
CREATE TABLE insight_observations (
 owner_id TEXT NOT NULL, insight_id TEXT NOT NULL, observation_id TEXT NOT NULL,
 PRIMARY KEY(owner_id,insight_id,observation_id),
 FOREIGN KEY(owner_id,insight_id) REFERENCES insights(owner_id,insight_id),
 FOREIGN KEY(owner_id,observation_id) REFERENCES observations(owner_id,observation_id)
);
CREATE TRIGGER insight_observation_scope BEFORE INSERT ON insight_observations WHEN NOT EXISTS(SELECT 1 FROM insights n JOIN observations o ON o.owner_id=n.owner_id JOIN analysis_runs r ON r.owner_id=o.owner_id AND r.run_id=o.run_id AND r.item_id=n.item_id AND r.state='ACCEPTED' WHERE n.owner_id=NEW.owner_id AND n.insight_id=NEW.insight_id AND o.observation_id=NEW.observation_id) BEGIN SELECT RAISE(ABORT,'INVALID_INSIGHT_OBSERVATION'); END;
CREATE TABLE organization_mutations (
 owner_id TEXT NOT NULL REFERENCES owner_users(owner_id), mutation_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('SPACE','MEMBERSHIP','REVIEW','INSIGHT')), target_id TEXT NOT NULL,
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64), write_token TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL,
 authored_by TEXT NOT NULL CHECK(authored_by=owner_id), recorded_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,mutation_id)
);
CREATE TRIGGER organization_mutation_no_update BEFORE UPDATE ON organization_mutations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ORGANIZATION_EVENT'); END;
CREATE TRIGGER organization_mutation_no_delete BEFORE DELETE ON organization_mutations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ORGANIZATION_EVENT'); END;
CREATE TRIGGER projection_invalidate_organization_insert AFTER INSERT ON organization_mutations BEGIN INSERT INTO change_log(owner_id,component,target_id,event_type,created_at) VALUES(NEW.owner_id,'organization',NEW.target_id,NEW.action||'_CHANGED',NEW.recorded_at); END;
CREATE TRIGGER spaces_backup_insert BEFORE INSERT ON spaces WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER spaces_backup_update BEFORE UPDATE ON spaces WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER spaces_backup_delete BEFORE DELETE ON spaces WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER item_spaces_backup_insert BEFORE INSERT ON item_spaces WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER item_spaces_backup_update BEFORE UPDATE ON item_spaces WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER item_spaces_backup_delete BEFORE DELETE ON item_spaces WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER review_state_backup_insert BEFORE INSERT ON review_state WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER review_state_backup_update BEFORE UPDATE ON review_state WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER review_state_backup_delete BEFORE DELETE ON review_state WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER insights_backup_insert BEFORE INSERT ON insights WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER insights_backup_update BEFORE UPDATE ON insights WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER insights_backup_delete BEFORE DELETE ON insights WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER insight_observations_backup_insert BEFORE INSERT ON insight_observations WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER insight_observations_backup_update BEFORE UPDATE ON insight_observations WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER insight_observations_backup_delete BEFORE DELETE ON insight_observations WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER organization_mutations_backup_insert BEFORE INSERT ON organization_mutations WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
