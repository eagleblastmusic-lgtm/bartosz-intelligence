import { sha256 } from '../../auth/crypto.js';
import type { AccessContext, Database } from '../../db/boundary.js';
import type { SourceIdentity } from '../../../../contracts/src/discovery.js';
import { jobDedup } from '../../jobs/policy.js';
export function backfillWindow(
  now: Date,
  range: 'only-new' | 7 | 30 | 90 | 'custom' = 30,
  start?: string,
  end?: string,
) {
  const windowEnd = range === 'custom' ? end : now.toISOString();
  const windowStart =
    range === 'only-new'
      ? now.toISOString()
      : range === 'custom'
        ? start
        : new Date(now.getTime() - range * 86400000).toISOString();
  if (
    !windowStart ||
    !windowEnd ||
    !Number.isFinite(Date.parse(windowStart)) ||
    !Number.isFinite(Date.parse(windowEnd)) ||
    Date.parse(windowStart) > Date.parse(windowEnd) ||
    Date.parse(windowEnd) > now.getTime() ||
    Date.parse(windowStart) < now.getTime() - 3660 * 86400000
  )
    throw new Error('INVALID_WINDOW');
  return {
    window_start: new Date(windowStart).toISOString(),
    window_end: new Date(windowEnd).toISOString(),
  };
}
export async function addSource(
  db: Database,
  context: AccessContext,
  identity: SourceIdentity,
  idempotencyKey: string,
  window: { window_start: string; window_end: string },
  now: Date,
) {
  context.requireOwner();
  if (
    !/^[\w-]{8,128}$/.test(idempotencyKey) ||
    !/^UC[\w-]{22}$/.test(identity.external_id) ||
    !/^UU[\w-]{22}$/.test(identity.uploads_playlist_id) ||
    identity.namespace !== 'youtube' ||
    identity.canonical_locator !==
      `https://www.youtube.com/channel/${identity.external_id}`
  )
    throw new Error('INVALID_SOURCE_INTENT');
  backfillWindow(now, 'custom', window.window_start, window.window_end);
  const payloadHash = await sha256(
    JSON.stringify([
      identity.external_id,
      window.window_start,
      window.window_end,
      'economy-1',
    ]),
  );
  const existing = await db
    .prepare(
      'SELECT payload_hash,source_id,job_id FROM source_requests WHERE owner_id=? AND idempotency_key=?',
    )
    .bind(context.ownerId, idempotencyKey)
    .first<{ payload_hash: string; source_id: string; job_id: string }>();
  if (existing) {
    if (existing.payload_hash !== payloadHash)
      throw new Error('IDEMPOTENCY_CONFLICT');
    return { source_id: existing.source_id, job_id: existing.job_id };
  }
  const nonce = crypto.randomUUID(),
    sourceId = crypto.randomUUID(),
    jobId = crypto.randomUUID(),
    at = now.toISOString();
  const dedup = await jobDedup(context.ownerId, {
    item_id: null,
    source_id: `youtube:${identity.external_id}`,
    task_type: 'DISCOVER',
    input_revision: payloadHash,
    profile_revision: 'economy-1',
    prompt_snapshot_id: null,
    routing_policy_version: 'control-plane-1',
    wire_schema_version: null,
    canonical_schema_version: null,
    enrichment_version: null,
    explicit_run_nonce: '',
    arrival_origin_at: at,
    origin_kind: 'BACKFILL',
    payload: window,
    priority: 100,
    due_at: at,
  });
  const guard =
    'EXISTS(SELECT 1 FROM source_requests WHERE owner_id=? AND idempotency_key=? AND permit_nonce=?)';
  const permit = [context.ownerId, idempotencyKey, nonce] as const;
  await db.batch([
    db
      .prepare(
        'INSERT INTO source_requests(owner_id,idempotency_key,payload_hash,permit_nonce,created_at) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,idempotency_key) DO NOTHING',
      )
      .bind(context.ownerId, idempotencyKey, payloadHash, nonce, at),
    db
      .prepare(
        `INSERT INTO sources(source_id,owner_id,namespace,external_id,canonical_locator,profile_revision,activated_at,due_at,window_start,rss_due_at,head_due_at,full_due_at,weekly_due_at)
      SELECT ?,?,'youtube',?,?,'economy-1',?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(owner_id,namespace,external_id) DO NOTHING`,
      )
      .bind(
        sourceId,
        context.ownerId,
        identity.external_id,
        identity.canonical_locator,
        at,
        at,
        window.window_start,
        at,
        at,
        at,
        at,
        ...permit,
      ),
    db
      .prepare(
        `INSERT INTO channels(source_id,owner_id,youtube_channel_id,uploads_playlist_id,handle_snapshot,title)
      SELECT source_id,owner_id,external_id,?,?,? FROM sources WHERE owner_id=? AND namespace='youtube' AND external_id=? AND ${guard}
      ON CONFLICT(source_id) DO UPDATE SET uploads_playlist_id=excluded.uploads_playlist_id,handle_snapshot=excluded.handle_snapshot,title=excluded.title`,
      )
      .bind(
        identity.uploads_playlist_id,
        identity.handle,
        identity.title,
        context.ownerId,
        identity.external_id,
        ...permit,
      ),
    db
      .prepare(
        `INSERT INTO config_versions(config_id,owner_id,revision,payload_json,content_hash,created_at)
      SELECT 'source:'||source_id,owner_id,1,?,?,? FROM sources WHERE owner_id=? AND namespace='youtube' AND external_id=? AND ${guard}
      ON CONFLICT(owner_id,config_id,revision) DO NOTHING`,
      )
      .bind(
        JSON.stringify({ profile: 'ECONOMY', revision: 'economy-1', window }),
        payloadHash,
        at,
        context.ownerId,
        identity.external_id,
        ...permit,
      ),
    db
      .prepare(
        `INSERT INTO jobs(job_id,owner_id,source_id,task_type,input_revision,profile_revision,routing_policy_version,explicit_run_nonce,dedup_key,state,due_at,priority,arrival_origin_at,origin_kind,payload_json,created_at,updated_at)
      SELECT ?,owner_id,source_id,'DISCOVER',?,'economy-1','control-plane-1','',?,'PENDING',?,100,?,'BACKFILL',?,?,? FROM sources WHERE owner_id=? AND namespace='youtube' AND external_id=? AND ${guard}
      ON CONFLICT(owner_id,dedup_key) DO NOTHING`,
      )
      .bind(
        jobId,
        payloadHash,
        dedup,
        at,
        at,
        JSON.stringify(window),
        at,
        at,
        context.ownerId,
        identity.external_id,
        ...permit,
      ),
    db
      .prepare(
        `INSERT INTO discovery_scans(scan_id,owner_id,source_id,job_id,window_start,window_end,coverage,started_at)
      SELECT ?,owner_id,source_id,job_id,?,?,'PENDING',? FROM jobs WHERE owner_id=? AND dedup_key=? AND ${guard} ON CONFLICT(owner_id,job_id) DO NOTHING`,
      )
      .bind(
        crypto.randomUUID(),
        window.window_start,
        window.window_end,
        at,
        context.ownerId,
        dedup,
        ...permit,
      ),
    db
      .prepare(
        `INSERT INTO outbox(event_id,owner_id,event_key,job_id,payload_json,due_at)
      SELECT ?,owner_id,'backfill:'||job_id,job_id,json_object('job_id',job_id,'fencing_hint',NULL,'task_type',task_type),due_at FROM jobs WHERE owner_id=? AND dedup_key=? AND ${guard}
      ON CONFLICT(owner_id,event_key) DO NOTHING`,
      )
      .bind(crypto.randomUUID(), context.ownerId, dedup, ...permit),
    db
      .prepare(
        `UPDATE source_requests SET source_id=(SELECT source_id FROM sources WHERE owner_id=? AND namespace='youtube' AND external_id=?),job_id=(SELECT job_id FROM jobs WHERE owner_id=? AND dedup_key=?) WHERE owner_id=? AND idempotency_key=? AND permit_nonce=?`,
      )
      .bind(
        context.ownerId,
        identity.external_id,
        context.ownerId,
        dedup,
        ...permit,
      ),
    db
      .prepare(
        `INSERT INTO change_log(owner_id,component,target_id,event_type,created_at) SELECT owner_id,'sources',source_id,'BACKFILL_REQUESTED',? FROM source_requests WHERE owner_id=? AND idempotency_key=? AND permit_nonce=?`,
      )
      .bind(at, ...permit),
  ]);
  const outcome = await db
    .prepare(
      'SELECT payload_hash,source_id,job_id FROM source_requests WHERE owner_id=? AND idempotency_key=?',
    )
    .bind(context.ownerId, idempotencyKey)
    .first<{ payload_hash: string; source_id: string; job_id: string }>();
  if (!outcome?.source_id || !outcome.job_id)
    throw new Error('SOURCE_INTENT_NOT_COMMITTED');
  if (outcome.payload_hash !== payloadHash)
    throw new Error('IDEMPOTENCY_CONFLICT');
  return { source_id: outcome.source_id, job_id: outcome.job_id };
}
