import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import {
  randomToken,
  sha256,
  sign,
} from '../../packages/core/src/auth/crypto.js';

// Isolated synthetic data only; never runs against the owner's database.
export const uxSessionSecret = 'ux-fixture-session-signing-key-only-32-bytes';
export async function uxFixtureSql(items: number) {
  if (items !== 10000) throw new Error('UX_REQUIRES_10000_ITEMS');
  const token = randomToken(),
    at = new Date().toISOString();
  const cookie = token + '.' + (await sign(token, uxSessionSecret));
  const sql = readdirSync('db/migrations')
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((n) => readFileSync('db/migrations/' + n, 'utf8'))
    .join('\n');
  return {
    cookie,
    sql:
      sql +
      `
INSERT INTO owner_users VALUES('ux-owner','https://accounts.google.com','ux-fixture-owner',1,'${at}');
INSERT INTO owner_sessions(session_hash,owner_id,csrf_hash,created_at,expires_at) VALUES('${await sha256(token)}','ux-owner','fixture','${at}','${new Date(Date.now() + 3600000).toISOString()}');
INSERT INTO sources(source_id,owner_id,namespace,external_id,canonical_locator,profile_revision,activated_at,due_at) VALUES
('ux-a','ux-owner','youtube','UCaaaaaaaaaaaaaaaaaaaaaa','https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa','economy-1','${at}','${at}'),
('ux-b','ux-owner','youtube','UCbbbbbbbbbbbbbbbbbbbbbb','https://www.youtube.com/channel/UCbbbbbbbbbbbbbbbbbbbbbb','economy-1','${at}','${at}');
INSERT INTO channels VALUES('ux-a','ux-owner','UCaaaaaaaaaaaaaaaaaaaaaa','UUaaaaaaaaaaaaaaaaaaaaaa','@fixture-a','Kanał gospodarczy — długi tytuł do sprawdzenia układu');
INSERT INTO channels VALUES('ux-b','ux-owner','UCbbbbbbbbbbbbbbbbbbbbbb','UUbbbbbbbbbbbbbbbbbbbbbb','@fixture-b','Kanał technologiczny');
WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${items})
INSERT INTO items(item_id,owner_id,source_id,namespace,external_id,item_type,canonical_url,published_at,publication_provenance,discovered_at,availability)
SELECT 'ux-'||x,'ux-owner',CASE WHEN x%2=0 THEN 'ux-a' ELSE 'ux-b' END,'youtube',printf('%011d',x),'video','https://www.youtube.com/watch?v='||printf('%011d',x),'2026-10-05T10:00:00.000Z','videos.snippet.publishedAt','${at}','PUBLIC' FROM n;
INSERT INTO item_revisions(revision_id,owner_id,item_id,metadata_hash,metadata_json,fetched_at,availability)
SELECT 'rev-'||item_id,owner_id,item_id,'hash-'||item_id,json_object('title','Publikacja '||item_id||' — gospodarka, technologia i analiza źródła z długim polskim tytułem','duration_seconds',3600),'${at}','PUBLIC' FROM items;
UPDATE items SET current_revision_id='rev-'||item_id;
INSERT INTO jobs(job_id,owner_id,item_id,source_id,task_type,input_revision,profile_revision,routing_policy_version,explicit_run_nonce,dedup_key,state,reason_code,due_at,priority,arrival_origin_at,origin_kind,payload_json,created_at,updated_at)
SELECT 'job-'||item_id,owner_id,item_id,source_id,'ANALYZE','fixture','fixture','local-primary-1','','dedup-'||item_id,
CASE CAST(substr(item_id,4) AS INTEGER)%6 WHEN 0 THEN 'SUCCEEDED' WHEN 1 THEN 'PENDING' WHEN 2 THEN 'DEFERRED' WHEN 3 THEN 'FAILED' WHEN 4 THEN 'BLOCKED' ELSE 'RETRY_WAIT' END,
CASE CAST(substr(item_id,4) AS INTEGER)%6 WHEN 0 THEN NULL WHEN 1 THEN NULL WHEN 2 THEN 'QUOTA_UNKNOWN_OR_STALE' WHEN 3 THEN 'NO_CAPTIONS' WHEN 4 THEN 'SOURCE_UNAVAILABLE' ELSE 'REVIEW_REQUIRED' END,
'${at}',80,'2026-10-01T00:00:00.000Z','NEW','{"snapshot":{"settings":{"mode":"PRODUCTION"}}}','${at}','${at}' FROM items;
INSERT INTO analysis_runs(run_id,owner_id,item_id,job_id,input_snapshot_json,profile_snapshot_json,routing_snapshot_json,state,outcome_json,created_at,accepted_at)
SELECT 'run-'||item_id,owner_id,item_id,job_id,'{}','{}','{}','ACCEPTED',json_object('version','intelligence-accepted:1','view',json_object('version','accepted-view:1','status','OK','enabled_modules',json_array('summary','claims'),'coverage_complete',json('true'),'summary_pl',json_array(json_object('text_pl','Syntetyczna notatka do pomiaru układu i renderowania; nie jest wynikiem AI ani dowodem jakości. Warunki, negacja i zakres wypowiedzi pozostają oddzielne od statusu przetwarzania.','evidence_ids',json_array())),'key_points',json_array(),'entities',json_array(),'tools',json_array(),'typed_counts',json_object('claims',1))),'${at}','${at}' FROM jobs WHERE state='SUCCEEDED';
INSERT INTO active_analysis_selections SELECT owner_id,item_id,run_id,1,run_id FROM analysis_runs;
`,
    fixture_id: randomUUID(),
  };
}
