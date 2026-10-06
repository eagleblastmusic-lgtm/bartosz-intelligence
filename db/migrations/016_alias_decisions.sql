-- Owner-authored alias decisions extend existing immutable aliases; raw entities remain unchanged.
CREATE TABLE entity_alias_decisions (
 owner_id TEXT NOT NULL, decision_id TEXT NOT NULL, entity_id TEXT NOT NULL, alias_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), action TEXT NOT NULL CHECK(action IN ('APPROVE','REVOKE')),
 normalized_literal TEXT NOT NULL, entity_type TEXT NOT NULL,
 language TEXT CHECK(language IS NULL OR length(language) BETWEEN 2 AND 35),
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000), authored_by TEXT NOT NULL CHECK(authored_by=owner_id),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64), recorded_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,decision_id), UNIQUE(owner_id,entity_id,revision),
 FOREIGN KEY(owner_id,entity_id) REFERENCES entities(owner_id,entity_id),
 FOREIGN KEY(owner_id,alias_id) REFERENCES entity_aliases(owner_id,alias_id),
 FOREIGN KEY(authored_by) REFERENCES owner_users(owner_id)
);
CREATE INDEX alias_decision_latest ON entity_alias_decisions(owner_id,alias_id,revision DESC);
CREATE INDEX alias_decision_literal_type ON entity_alias_decisions(owner_id,normalized_literal,entity_type,language);
CREATE TRIGGER alias_decision_validate BEFORE INSERT ON entity_alias_decisions
WHEN NEW.revision != COALESCE((SELECT MAX(revision) FROM entity_alias_decisions WHERE owner_id=NEW.owner_id AND entity_id=NEW.entity_id),0)+1
 OR NOT EXISTS(SELECT 1 FROM entity_aliases a JOIN entities e ON e.owner_id=a.owner_id AND e.entity_id=a.entity_id WHERE a.owner_id=NEW.owner_id AND a.alias_id=NEW.alias_id AND a.entity_id=NEW.entity_id AND a.literal=NEW.normalized_literal AND e.entity_type=NEW.entity_type)
BEGIN SELECT RAISE(ABORT,'INVALID_ALIAS_DECISION'); END;
CREATE TRIGGER alias_decision_no_update BEFORE UPDATE ON entity_alias_decisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ALIAS_DECISION'); END;
CREATE TRIGGER alias_decision_no_delete BEFORE DELETE ON entity_alias_decisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ALIAS_DECISION'); END;
CREATE TRIGGER alias_decision_backup_insert BEFORE INSERT ON entity_alias_decisions WHEN EXISTS(SELECT 1 FROM maintenance_state WHERE barrier_token IS NOT NULL AND barrier_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'BACKUP_MUTATION_PAUSED'); END;
CREATE TRIGGER projection_invalidate_alias_decision_insert AFTER INSERT ON entity_alias_decisions
BEGIN INSERT INTO change_log(owner_id,component,target_id,event_type,created_at) VALUES(NEW.owner_id,'entity_aliases',NEW.entity_id,'ALIAS_DECISION',NEW.recorded_at); END;
