CREATE TABLE entity_identity_events (
 owner_id TEXT NOT NULL REFERENCES owner_users(owner_id), event_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('MERGE','SPLIT','UNDO')), source_entity_id TEXT NOT NULL,
 target_entity_id TEXT NOT NULL, parent_event_id TEXT, reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 authored_by TEXT NOT NULL CHECK(authored_by=owner_id), expected_json TEXT NOT NULL CHECK(json_valid(expected_json)),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64), recorded_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,event_id),
 FOREIGN KEY(owner_id,source_entity_id) REFERENCES entities(owner_id,entity_id),
 FOREIGN KEY(owner_id,target_entity_id) REFERENCES entities(owner_id,entity_id),
 FOREIGN KEY(owner_id,parent_event_id) REFERENCES entity_identity_events(owner_id,event_id)
);
CREATE TABLE entity_identity_members (
 owner_id TEXT NOT NULL, event_id TEXT NOT NULL, entity_id TEXT NOT NULL,
 effective_entity_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 PRIMARY KEY(owner_id,event_id,entity_id), UNIQUE(owner_id,entity_id,revision),
 FOREIGN KEY(owner_id,event_id) REFERENCES entity_identity_events(owner_id,event_id),
 FOREIGN KEY(owner_id,entity_id) REFERENCES entities(owner_id,entity_id),
 FOREIGN KEY(owner_id,effective_entity_id) REFERENCES entities(owner_id,entity_id)
);
CREATE INDEX identity_member_latest ON entity_identity_members(owner_id,entity_id,revision DESC);
CREATE TRIGGER identity_member_validate BEFORE INSERT ON entity_identity_members
WHEN NEW.revision!=COALESCE((SELECT MAX(revision) FROM entity_identity_members WHERE owner_id=NEW.owner_id AND entity_id=NEW.entity_id),0)+1
 OR NOT EXISTS(SELECT 1 FROM entities a JOIN entities b ON b.owner_id=a.owner_id AND b.entity_type=a.entity_type WHERE a.owner_id=NEW.owner_id AND a.entity_id=NEW.entity_id AND b.entity_id=NEW.effective_entity_id)
BEGIN SELECT RAISE(ABORT,'INVALID_IDENTITY_MEMBER'); END;
CREATE TRIGGER identity_event_no_update BEFORE UPDATE ON entity_identity_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_IDENTITY_EVENT'); END;
CREATE TRIGGER identity_event_no_delete BEFORE DELETE ON entity_identity_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_IDENTITY_EVENT'); END;
CREATE TRIGGER identity_member_no_update BEFORE UPDATE ON entity_identity_members BEGIN SELECT RAISE(ABORT,'IMMUTABLE_IDENTITY_MEMBER'); END;
CREATE TRIGGER identity_member_no_delete BEFORE DELETE ON entity_identity_members BEGIN SELECT RAISE(ABORT,'IMMUTABLE_IDENTITY_MEMBER'); END;
CREATE TRIGGER identity_event_backup_insert BEFORE INSERT ON entity_identity_events WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER identity_member_backup_insert BEFORE INSERT ON entity_identity_members WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER projection_invalidate_identity_event_insert AFTER INSERT ON entity_identity_events
BEGIN INSERT INTO change_log(owner_id,component,target_id,event_type,created_at) VALUES(NEW.owner_id,'entities',NEW.event_id,'IDENTITY_CHANGED',NEW.recorded_at); END;
