-- Derived only: portable backups contain canonical rows/artifacts, not FTS.
CREATE TABLE search_documents (
 owner_id TEXT NOT NULL REFERENCES owner_users(owner_id), doc_id TEXT NOT NULL, parent_id TEXT NOT NULL,
 item_id TEXT, run_id TEXT, kind TEXT NOT NULL,
 observation_id TEXT, entity_id TEXT, text TEXT NOT NULL, search_text TEXT NOT NULL,
 content_hash TEXT NOT NULL CHECK(length(content_hash)=64), generation TEXT NOT NULL,
 PRIMARY KEY(owner_id,doc_id), FOREIGN KEY(owner_id,item_id) REFERENCES items(owner_id,item_id)
);
CREATE INDEX search_owner_generation ON search_documents(owner_id,generation,doc_id);
CREATE INDEX search_item_document_lookup ON search_documents(owner_id,item_id,doc_id);
CREATE INDEX search_parent_documents ON search_documents(owner_id,parent_id,generation);
CREATE INDEX search_item_cursor ON items(owner_id,('ITEM:'||item_id));
CREATE INDEX search_observation_cursor ON observations(owner_id,('OBSERVATION:'||observation_id));
CREATE INDEX search_insight_cursor ON insights(owner_id,('INSIGHT:'||insight_id));
CREATE INDEX search_entity_cursor ON entities(owner_id,('ENTITY:'||entity_id));
CREATE INDEX search_alias_cursor ON entity_aliases(owner_id,('ALIAS:'||alias_id));
CREATE INDEX search_summary_cursor ON analysis_runs(owner_id,('SUMMARY_PREVIEW:'||run_id));
CREATE VIRTUAL TABLE knowledge_fts USING fts5(search_text,content='search_documents',content_rowid='rowid',tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER search_document_insert AFTER INSERT ON search_documents BEGIN INSERT INTO knowledge_fts(rowid,search_text) VALUES(NEW.rowid,NEW.search_text); END;
CREATE TRIGGER search_document_delete AFTER DELETE ON search_documents BEGIN INSERT INTO knowledge_fts(knowledge_fts,rowid,search_text) VALUES('delete',OLD.rowid,OLD.search_text); END;
CREATE TRIGGER search_document_update AFTER UPDATE OF search_text ON search_documents BEGIN INSERT INTO knowledge_fts(knowledge_fts,rowid,search_text) VALUES('delete',OLD.rowid,OLD.search_text); INSERT INTO knowledge_fts(rowid,search_text) VALUES(NEW.rowid,NEW.search_text); END;
CREATE TABLE search_index_state (
 owner_id TEXT PRIMARY KEY REFERENCES owner_users(owner_id), generation TEXT NOT NULL,
 indexed_cut INTEGER NOT NULL CHECK(indexed_cut>=0), target_cut INTEGER NOT NULL CHECK(target_cut>=0),
 phase TEXT NOT NULL CHECK(phase IN ('BUILDING','CLEANUP','COMPLETE')), cursor TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE VIEW search_item_documents(owner_id,doc_id,item_id,run_id,kind,observation_id,entity_id,text) AS
SELECT i.owner_id,'ITEM:'||i.item_id doc_id,i.item_id,NULL run_id,'ITEM' kind,NULL observation_id,NULL entity_id,COALESCE(json_extract(m.metadata_json,'$.title'),'') text
 FROM items i JOIN item_revisions m ON m.owner_id=i.owner_id AND m.item_id=i.item_id AND m.revision_id=i.current_revision_id;
CREATE VIEW search_observation_documents(owner_id,doc_id,item_id,run_id,kind,observation_id,entity_id,text) AS
SELECT o.owner_id,'OBSERVATION:'||o.observation_id,r.item_id,o.run_id,'OBSERVATION',o.observation_id,NULL,
 COALESCE(json_extract(o.row_json,'$.content_pl'),'')||COALESCE((SELECT char(10)||'Korekta właściciela: '||v.new_value FROM correction_overlays v WHERE v.owner_id=o.owner_id AND v.target_kind='OBSERVATION_TEXT' AND v.target_id=o.observation_id ORDER BY v.revision DESC LIMIT 1),'')
 FROM observations o JOIN analysis_runs r ON r.owner_id=o.owner_id AND r.run_id=o.run_id AND r.state='ACCEPTED' AND json_extract(r.outcome_json,'$.version')='intelligence-accepted:1' JOIN active_analysis_selections s ON s.owner_id=r.owner_id AND s.item_id=r.item_id AND s.accepted_run_id=r.run_id;
CREATE VIEW search_insight_documents(owner_id,doc_id,item_id,run_id,kind,observation_id,entity_id,text) AS
SELECT n.owner_id,'INSIGHT:'||n.insight_id,n.item_id,NULL,'INSIGHT',NULL,NULL,n.text FROM insights n WHERE n.active=1;
CREATE VIEW search_entity_documents(owner_id,doc_id,item_id,run_id,kind,observation_id,entity_id,text) AS
SELECT e.owner_id,'ENTITY:'||e.entity_id,NULL,NULL,'ENTITY',NULL,e.entity_id,e.label||COALESCE((SELECT char(10)||'Nazwa właściciela: '||v.new_value FROM correction_overlays v WHERE v.owner_id=e.owner_id AND v.target_kind='ENTITY_LABEL' AND v.target_id=e.entity_id ORDER BY v.revision DESC LIMIT 1),'') FROM entities e;
CREATE VIEW search_alias_documents(owner_id,doc_id,item_id,run_id,kind,observation_id,entity_id,text) AS
SELECT a.owner_id,'ALIAS:'||a.alias_id,NULL,NULL,'ALIAS',NULL,COALESCE((SELECT x.effective_entity_id FROM entity_identity_members x WHERE x.owner_id=a.owner_id AND x.entity_id=a.entity_id ORDER BY x.revision DESC LIMIT 1),a.entity_id),a.literal FROM entity_aliases a WHERE COALESCE((SELECT d.action FROM entity_alias_decisions d WHERE d.owner_id=a.owner_id AND d.alias_id=a.alias_id ORDER BY d.revision DESC LIMIT 1),'APPROVE')='APPROVE';
CREATE VIEW search_summary_documents(owner_id,doc_id,item_id,run_id,kind,observation_id,entity_id,text) AS
SELECT r.owner_id,'SUMMARY_PREVIEW:'||r.run_id||':'||j.key,r.item_id,r.run_id,'SUMMARY_PREVIEW',NULL,NULL,json_extract(j.value,'$.text_pl') FROM analysis_runs r JOIN active_analysis_selections s ON s.owner_id=r.owner_id AND s.item_id=r.item_id AND s.accepted_run_id=r.run_id JOIN json_each(r.outcome_json,'$.view.summary_pl') j WHERE r.state='ACCEPTED' AND json_extract(r.outcome_json,'$.version')='intelligence-accepted:1';
CREATE VIEW search_content_documents AS SELECT * FROM search_item_documents UNION ALL SELECT * FROM search_observation_documents UNION ALL SELECT * FROM search_insight_documents;
CREATE VIEW search_reference_documents AS SELECT * FROM search_entity_documents UNION ALL SELECT * FROM search_alias_documents UNION ALL SELECT * FROM search_summary_documents;
CREATE VIEW search_source_documents AS SELECT * FROM search_content_documents UNION ALL SELECT * FROM search_reference_documents;
