import type { Database } from '../../db/boundary.js';
import { jobDedup } from '../../jobs/policy.js';
export function discoveryWindow(
  now: Date,
  sourceStart: string,
  lastComplete: string | null,
  kind: 'FULL' | 'WEEKLY' | 'HEAD' | 'RSS',
) {
  const base = Date.parse(sourceStart),
    watermark = lastComplete === null ? base : Date.parse(lastComplete);
  if (
    !Number.isFinite(base) ||
    !Number.isFinite(watermark) ||
    base > now.getTime() ||
    watermark > now.getTime()
  )
    throw new Error('INVALID_DISCOVERY_CLOCK');
  const start =
    kind === 'WEEKLY'
      ? Math.max(base, now.getTime() - 90 * 86400000)
      : Math.max(base, watermark - 48 * 3600000);
  return {
    window_start: new Date(start).toISOString(),
    window_end: now.toISOString(),
    gap_seconds: Math.max(0, (now.getTime() - watermark) / 1000),
  };
}
interface DueSource {
  source_id: string;
  owner_id: string;
  window_start: string | null;
  activated_at: string;
  last_complete_window_end: string | null;
  rss_due_at: string | null;
  head_due_at: string | null;
  full_due_at: string | null;
  weekly_due_at: string | null;
}
export async function scheduleSources(
  db: Database,
  now: Date,
  limit = 5,
  random = Math.random,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error('INVALID_LIMIT');
  const at = now.toISOString();
  // Five sources fits the free query budget alongside bounded lease recovery.
  const sources = (
    await db
      .prepare(
        `SELECT s.* FROM sources s WHERE enabled=1 AND due_at<=?1 AND (
           ((weekly_due_at IS NULL OR weekly_due_at<=?1 OR full_due_at IS NULL OR full_due_at<=?1) AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.owner_id=s.owner_id AND j.source_id=s.source_id AND j.task_type IN ('DISCOVER','RECONCILE') AND COALESCE(json_extract(j.payload_json,'$.mode'),'FULL')='FULL' AND j.state IN ('PENDING','LEASED','RUNNING','DEFERRED','RETRY_WAIT'))) OR
           ((head_due_at IS NULL OR head_due_at<=?1) AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.owner_id=s.owner_id AND j.source_id=s.source_id AND json_extract(j.payload_json,'$.mode')='HEAD' AND j.state IN ('PENDING','LEASED','RUNNING','DEFERRED','RETRY_WAIT'))) OR
           ((rss_due_at IS NULL OR rss_due_at<=?1) AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.owner_id=s.owner_id AND j.source_id=s.source_id AND json_extract(j.payload_json,'$.mode')='RSS' AND j.state IN ('PENDING','LEASED','RUNNING','DEFERRED','RETRY_WAIT')))
           ) ORDER BY due_at,source_id LIMIT ?2`,
      )
      .bind(at, Math.min(limit, 5))
      .all<DueSource>()
  ).results;
  let scheduled = 0;
  for (const source of sources) {
    const active = (
      await db
        .prepare(
          "SELECT COALESCE(json_extract(payload_json,'$.mode'),'FULL') AS mode FROM jobs WHERE owner_id=? AND source_id=? AND task_type IN ('DISCOVER','RECONCILE') AND state IN ('PENDING','LEASED','RUNNING','DEFERRED','RETRY_WAIT') LIMIT 10",
        )
        .bind(source.owner_id, source.source_id)
        .all<{ mode: string }>()
    ).results;
    const activeModes = new Set(active.map((row) => row.mode));
    const kind = (['WEEKLY', 'FULL', 'HEAD', 'RSS'] as const).find((kind) => {
      const due =
        kind === 'WEEKLY'
          ? source.weekly_due_at
          : kind === 'FULL'
            ? source.full_due_at
            : kind === 'HEAD'
              ? source.head_due_at
              : source.rss_due_at;
      return (
        (due === null || due <= at) &&
        !activeModes.has(kind === 'WEEKLY' ? 'FULL' : kind)
      );
    });
    if (!kind) continue;
    const window = discoveryWindow(
      now,
      source.window_start ?? source.activated_at,
      source.last_complete_window_end,
      kind,
    );
    const jobId = crypto.randomUUID(),
      type = kind === 'WEEKLY' || kind === 'FULL' ? 'RECONCILE' : 'DISCOVER';
    const inputRevision = `${kind}:${at}`,
      scanId = crypto.randomUUID();
    const payload = { ...window, mode: kind === 'WEEKLY' ? 'FULL' : kind };
    const priority = kind === 'RSS' ? 130 : kind === 'HEAD' ? 120 : 100;
    const dedup = await jobDedup(source.owner_id, {
      item_id: null,
      source_id: source.source_id,
      task_type: type,
      input_revision: inputRevision,
      profile_revision: 'economy-1',
      prompt_snapshot_id: null,
      routing_policy_version: 'control-plane-1',
      wire_schema_version: null,
      canonical_schema_version: null,
      enrichment_version: null,
      explicit_run_nonce: '',
      arrival_origin_at: at,
      origin_kind: 'INTEGRITY',
      payload,
      priority,
      due_at: at,
    });
    const jitter = random();
    if (jitter < 0 || jitter >= 1) throw new Error('INVALID_JITTER');
    const next = {
      rss_due_at: new Date(
        now.getTime() + 1800000 + jitter * 300000,
      ).toISOString(),
      head_due_at: new Date(now.getTime() + 7200000).toISOString(),
      full_due_at: new Date(now.getTime() + 86400000).toISOString(),
      weekly_due_at: new Date(now.getTime() + 7 * 86400000).toISOString(),
    };
    const rss =
      kind === 'RSS' ? next.rss_due_at : (source.rss_due_at ?? next.rss_due_at);
    const head =
      kind === 'HEAD'
        ? next.head_due_at
        : (source.head_due_at ?? next.head_due_at);
    const full =
      kind === 'FULL'
        ? next.full_due_at
        : (source.full_due_at ?? next.full_due_at);
    const weekly =
      kind === 'WEEKLY'
        ? next.weekly_due_at
        : (source.weekly_due_at ?? next.weekly_due_at);
    const sourceDue = [rss, head, full, weekly].sort()[0]!;
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO jobs(job_id,owner_id,source_id,task_type,input_revision,profile_revision,routing_policy_version,explicit_run_nonce,dedup_key,state,due_at,priority,arrival_origin_at,origin_kind,payload_json,created_at,updated_at)
        SELECT ?,owner_id,source_id,?,?,'economy-1','control-plane-1','',?,'PENDING',?,?,?,'INTEGRITY',?,?,? FROM sources WHERE owner_id=? AND source_id=? AND enabled=1 AND due_at<=?
        AND NOT EXISTS(SELECT 1 FROM jobs WHERE owner_id=? AND source_id=? AND task_type IN ('DISCOVER','RECONCILE') AND COALESCE(json_extract(payload_json,'$.mode'),'FULL')=? AND state IN ('PENDING','LEASED','RUNNING','DEFERRED','RETRY_WAIT')) ON CONFLICT(owner_id,dedup_key) DO NOTHING`,
        )
        .bind(
          jobId,
          type,
          inputRevision,
          dedup,
          at,
          priority,
          at,
          JSON.stringify(payload),
          at,
          at,
          source.owner_id,
          source.source_id,
          at,
          source.owner_id,
          source.source_id,
          payload.mode,
        ),
      db
        .prepare(
          `INSERT INTO discovery_scans(scan_id,owner_id,source_id,job_id,window_start,window_end,coverage,started_at)
        SELECT ?,owner_id,source_id,job_id,?,?,'PENDING',? FROM jobs WHERE owner_id=? AND job_id=? ON CONFLICT(owner_id,job_id) DO NOTHING`,
        )
        .bind(
          scanId,
          window.window_start,
          window.window_end,
          at,
          source.owner_id,
          jobId,
        ),
      db
        .prepare(
          `UPDATE sources SET rss_due_at=?,head_due_at=?,full_due_at=?,weekly_due_at=?,due_at=? WHERE owner_id=? AND source_id=? AND EXISTS(SELECT 1 FROM jobs WHERE owner_id=? AND job_id=?)`,
        )
        .bind(
          rss,
          head,
          full,
          weekly,
          sourceDue,
          source.owner_id,
          source.source_id,
          source.owner_id,
          jobId,
        ),
    ]);
    if (results[0]?.meta.changes === 1) scheduled++;
  }
  return { examined: sources.length, scheduled, limit: Math.min(limit, 5) };
}
export async function repairMissingIntents(db: Database, now: Date, limit = 5) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5)
    throw new Error('INVALID_LIMIT');
  const rows = (
    await db
      .prepare(
        `SELECT i.owner_id,i.item_id,i.source_id,i.namespace,i.external_id,i.published_at,i.availability FROM items i JOIN sources s ON s.owner_id=i.owner_id AND s.source_id=i.source_id WHERE s.enabled=1 AND i.current_revision_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM retention_items t WHERE t.owner_id=i.owner_id AND t.item_id=i.item_id AND t.phase IN ('PRUNING','COMPLETE')) AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.owner_id=i.owner_id AND j.item_id=i.item_id AND j.task_type='FETCH_TRANSCRIPT' AND j.input_revision='source-intake-1') ORDER BY i.discovered_at,i.item_id LIMIT ?`,
      )
      .bind(limit)
      .all<{
        owner_id: string;
        item_id: string;
        source_id: string;
        namespace: string;
        external_id: string;
        published_at: string | null;
        availability: string;
      }>()
  ).results;
  for (const item of rows) {
    const at = now.toISOString();
    const dedup = await jobDedup(item.owner_id, {
      item_id: `${item.namespace}:${item.external_id}`,
      source_id: null,
      task_type: 'FETCH_TRANSCRIPT',
      input_revision: 'source-intake-1',
      profile_revision: 'economy-1',
      prompt_snapshot_id: null,
      routing_policy_version: 'local-primary-1',
      wire_schema_version: null,
      canonical_schema_version: null,
      enrichment_version: null,
      explicit_run_nonce: '',
      arrival_origin_at: item.published_at ?? at,
      origin_kind: 'NEW',
      payload: {},
      priority: 80,
      due_at: at,
    });
    await db.batch([
      db
        .prepare(
          `INSERT INTO jobs(job_id,owner_id,item_id,source_id,task_type,input_revision,profile_revision,routing_policy_version,explicit_run_nonce,dedup_key,state,reason_code,due_at,priority,arrival_origin_at,origin_kind,payload_json,created_at,updated_at)
        VALUES(?,?,?,?,'FETCH_TRANSCRIPT','source-intake-1','economy-1','local-primary-1','',?,?,?,?,80,?,'NEW','{}',?,?) ON CONFLICT(owner_id,dedup_key) DO NOTHING`,
        )
        .bind(
          crypto.randomUUID(),
          item.owner_id,
          item.item_id,
          item.source_id,
          dedup,
          item.availability === 'PUBLIC' ? 'PENDING' : 'BLOCKED',
          item.availability === 'PUBLIC' ? null : 'SOURCE_ACCESS',
          at,
          item.published_at ?? at,
          at,
          at,
        ),
      db
        .prepare(
          `INSERT INTO outbox(event_id,owner_id,event_key,job_id,payload_json,due_at)
        SELECT ?,owner_id,'job:'||job_id||':0',job_id,json_object('job_id',job_id,'fencing_hint',NULL,'task_type',task_type),due_at FROM jobs WHERE owner_id=? AND dedup_key=? AND state='PENDING' ON CONFLICT(owner_id,event_key) DO NOTHING`,
        )
        .bind(crypto.randomUUID(), item.owner_id, dedup),
    ]);
  }
  return { repaired: rows.length };
}
