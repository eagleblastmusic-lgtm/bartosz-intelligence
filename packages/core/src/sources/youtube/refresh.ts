import type { Database } from '../../db/boundary.js';
import { sha256 } from '../../auth/crypto.js';
import type { ItemMetadata } from '../../../../contracts/src/discovery.js';
// A successful scan really observed these Items even when the immutable metadata
// revision did not change. REFRESH/HEAD coverage remains PARTIAL by design.
export const metadataObservationPredicate = `AND NOT EXISTS(SELECT 1 FROM retention_items archived WHERE archived.owner_id=i.owner_id AND archived.item_id=i.item_id AND archived.phase IN ('PRUNING','COMPLETE')) AND NOT EXISTS(SELECT 1 FROM discovery_scan_members m JOIN discovery_scans d ON d.owner_id=m.owner_id AND d.scan_id=m.scan_id JOIN jobs checked ON checked.owner_id=d.owner_id AND checked.job_id=d.job_id WHERE m.owner_id=i.owner_id AND m.item_id=i.item_id AND checked.state='SUCCEEDED' AND checked.updated_at>? AND checked.updated_at<=?)`;
export async function scheduleMetadataRefresh(db: Database, now: Date) {
  const at = now.toISOString(),
    cutoff = new Date(now.getTime() - 30 * 86400000).toISOString();
  const source = await db
    .prepare(
      `SELECT i.owner_id,i.source_id FROM item_revisions r CROSS JOIN items i ON i.owner_id=r.owner_id AND i.item_id=r.item_id AND i.current_revision_id=r.revision_id JOIN sources s ON s.owner_id=i.owner_id AND s.source_id=i.source_id WHERE s.enabled=1 AND r.fetched_at<=?
    ${metadataObservationPredicate}
    AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.owner_id=i.owner_id AND j.source_id=i.source_id AND j.task_type='RECONCILE' AND json_extract(j.payload_json,'$.mode')='REFRESH' AND j.state IN ('PENDING','LEASED','RUNNING','DEFERRED','RETRY_WAIT')) ORDER BY r.fetched_at,i.item_id LIMIT 1`,
    )
    .bind(cutoff, cutoff, at)
    .first<{ owner_id: string; source_id: string }>();
  if (!source) return { scheduled: 0 };
  const items = (
    await db
      .prepare(
        `SELECT i.external_id,r.metadata_json FROM items i JOIN item_revisions r ON r.owner_id=i.owner_id AND r.item_id=i.item_id AND r.revision_id=i.current_revision_id WHERE i.owner_id=? AND i.source_id=? AND r.fetched_at<=? ${metadataObservationPredicate} ORDER BY r.fetched_at,i.item_id LIMIT 50`,
      )
      .bind(source.owner_id, source.source_id, cutoff, cutoff, at)
      .all<{ external_id: string; metadata_json: string }>()
  ).results;
  const payload = {
    mode: 'REFRESH',
    ids: items.map((item) => item.external_id),
    last_known: items.map(
      (item) => JSON.parse(item.metadata_json) as ItemMetadata,
    ),
  };
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 64000)
    throw new Error('REFRESH_BATCH_TOO_LARGE');
  const jobId = crypto.randomUUID(),
    dedup = await sha256(
      JSON.stringify([
        source.owner_id,
        source.source_id,
        'metadata-refresh',
        payload.ids,
        cutoff,
      ]),
    );
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO jobs(job_id,owner_id,source_id,task_type,input_revision,profile_revision,routing_policy_version,explicit_run_nonce,dedup_key,state,due_at,priority,arrival_origin_at,origin_kind,payload_json,created_at,updated_at)
      SELECT ?,?,?,'RECONCILE',?,'economy-1','control-plane-1','',?,'PENDING',?,110,?,'INTEGRITY',?,?,? WHERE NOT EXISTS(SELECT 1 FROM jobs WHERE owner_id=? AND source_id=? AND task_type='RECONCILE' AND json_extract(payload_json,'$.mode')='REFRESH' AND state IN ('PENDING','LEASED','RUNNING','DEFERRED','RETRY_WAIT')) ON CONFLICT(owner_id,dedup_key) DO NOTHING`,
      )
      .bind(
        jobId,
        source.owner_id,
        source.source_id,
        dedup,
        dedup,
        at,
        at,
        JSON.stringify(payload),
        at,
        at,
        source.owner_id,
        source.source_id,
      ),
    db
      .prepare(
        `INSERT INTO discovery_scans(scan_id,owner_id,source_id,job_id,window_start,window_end,coverage,started_at)
      SELECT ?,owner_id,source_id,job_id,'1970-01-01T00:00:00.000Z',?,'PENDING',? FROM jobs WHERE owner_id=? AND job_id=?`,
      )
      .bind(crypto.randomUUID(), at, at, source.owner_id, jobId),
  ]);
  return { scheduled: results[0]?.meta.changes ?? 0 };
}
