import type { AccessContext, Database, Statement } from '../../db/boundary.js';
import { ItemRepository } from '../../db/items.js';
import { sha256 } from '../../auth/crypto.js';
import { jobDedup } from '../../jobs/policy.js';
import { leasePredicate } from '../../jobs/lease-guard.js';
import type { LeaseToken, TaskType } from '../../../../contracts/src/jobs.js';
import type { ItemMetadata } from '../../../../contracts/src/discovery.js';
export interface ScanState {
  scan_id: string;
  source_id: string;
  job_id: string;
  window_start: string;
  window_end: string;
  cursor: string | null;
  page_revision: number;
  coverage: string;
  staged_page_json: string | null;
  staged_next_cursor: string | null;
  staged_page_hash: string | null;
  page_offset: number;
  job_payload_json: string;
  job_origin_kind: string;
  source_activated_at: string;
}
export async function getScan(
  db: Database,
  context: AccessContext,
  jobId: string,
) {
  return db
    .prepare(
      'SELECT s.*,j.payload_json AS job_payload_json,j.origin_kind AS job_origin_kind,src.activated_at AS source_activated_at FROM discovery_scans s JOIN jobs j ON j.owner_id=s.owner_id AND j.job_id=s.job_id JOIN sources src ON src.owner_id=s.owner_id AND src.source_id=s.source_id WHERE s.owner_id=? AND s.job_id=?',
    )
    .bind(context.ownerId, jobId)
    .first<ScanState>();
}
export async function restartExpiredCursor(
  db: Database,
  context: AccessContext,
  token: LeaseToken,
  scan: ScanState,
  now: Date,
  task: TaskType = 'DISCOVER',
) {
  const guard = leasePredicate(context, token, now.toISOString(), task);
  const result = await db
    .prepare(
      `UPDATE discovery_scans SET cursor=NULL,page_revision=page_revision+1,coverage='PARTIAL',commit_nonce=NULL,staged_page_json=NULL,staged_next_cursor=NULL,staged_page_hash=NULL,page_offset=0 WHERE owner_id=? AND scan_id=? AND job_id=? AND page_revision=? AND ${guard.predicate}`,
    )
    .bind(
      context.ownerId,
      scan.scan_id,
      token.job_id,
      scan.page_revision,
      ...guard.bindings,
    )
    .run();
  if (result.meta.changes !== 1) throw new Error('STALE_FENCE');
}
export async function commitDiscoveryPage(
  db: Database,
  context: AccessContext,
  token: LeaseToken,
  scan: ScanState,
  candidates: ItemMetadata[],
  nextCursor: string | null,
  now: Date,
  task: TaskType = 'DISCOVER',
  chunkSize = 5,
) {
  if (
    !Number.isInteger(chunkSize) ||
    chunkSize < 1 ||
    chunkSize > 5 ||
    candidates.length > 50 ||
    (nextCursor !== null && (!nextCursor || nextCursor.length > 2048))
  )
    throw new Error('INVALID_DISCOVERY_PAGE');
  const at = now.toISOString(),
    nonce = crypto.randomUUID(),
    lease = leasePredicate(context, token, at, task);
  if (scan.job_id !== token.job_id) throw new Error('STALE_FENCE');
  if (scan.staged_page_json === null) {
    const json = JSON.stringify(candidates);
    if (new TextEncoder().encode(json).byteLength > 64000)
      throw new Error('DISCOVERY_PAGE_TOO_LARGE');
    const staged = await db
      .prepare(
        `UPDATE discovery_scans SET staged_page_json=?,staged_next_cursor=?,staged_page_hash=?,page_offset=0 WHERE owner_id=? AND scan_id=? AND job_id=? AND page_revision=? AND staged_page_json IS NULL AND coverage IN ('PENDING','PARTIAL') AND ${lease.predicate}`,
      )
      .bind(
        json,
        nextCursor,
        await sha256(json),
        context.ownerId,
        scan.scan_id,
        token.job_id,
        scan.page_revision,
        ...lease.bindings,
      )
      .run();
    if (staged.meta.changes !== 1) throw new Error('STALE_FENCE');
  }
  const staged = (await getScan(db, context, token.job_id))!;
  const pageCandidates = JSON.parse(staged.staged_page_json!) as ItemMetadata[];
  const mode = JSON.parse(staged.job_payload_json).mode ?? 'FULL';
  if (!['FULL', 'HEAD', 'RSS', 'REFRESH'].includes(mode))
    throw new Error('INVALID_SCAN_MODE');
  // Every staged candidate is examined, even after old/known entries.
  // The SQL work budget counts candidates eligible for mutation, not skipped dates.
  let offsetAfter = staged.page_offset,
    writable = 0;
  while (offsetAfter < pageCandidates.length && writable < chunkSize) {
    const item = pageCandidates[offsetAfter++]!;
    if (
      mode === 'REFRESH' ||
      item.published_at === null ||
      (item.published_at >= scan.window_start &&
        item.published_at <= scan.window_end)
    )
      writable++;
  }
  const slice = pageCandidates.slice(staged.page_offset, offsetAfter);
  const pageFinished = offsetAfter >= pageCandidates.length;
  const jobDone =
    pageFinished && (staged.staged_next_cursor === null || mode !== 'FULL');
  const scanComplete = jobDone && mode === 'FULL';
  const cursorAfter = pageFinished ? staged.staged_next_cursor : scan.cursor;
  const permit = {
    predicate: `EXISTS(SELECT 1 FROM discovery_scans s WHERE s.owner_id=? AND s.scan_id=? AND s.job_id=? AND s.commit_nonce=?) AND ${lease.predicate}`,
    bindings: [
      context.ownerId,
      scan.scan_id,
      token.job_id,
      nonce,
      ...lease.bindings,
    ],
  };
  const statements: Statement[] = [
    db
      .prepare(
        `UPDATE discovery_scans SET commit_nonce=? WHERE owner_id=? AND scan_id=? AND job_id=? AND page_revision=? AND page_offset=? AND coverage IN ('PENDING','PARTIAL') AND ${lease.predicate}`,
      )
      .bind(
        nonce,
        context.ownerId,
        scan.scan_id,
        token.job_id,
        scan.page_revision,
        scan.page_offset,
        ...lease.bindings,
      ),
  ];
  const items = new ItemRepository(db, context);
  const unique = new Map(slice.map((item) => [item.external_id, item]));
  for (const item of unique.values()) {
    if (
      mode !== 'REFRESH' &&
      item.published_at !== null &&
      (item.published_at < scan.window_start ||
        item.published_at > scan.window_end)
    )
      continue;
    statements.push(
      ...(await items.prepareUpsert(scan.source_id, item, at, permit)),
    );
    const origin =
      item.published_at !== null
        ? item.published_at < staged.source_activated_at
          ? 'BACKFILL'
          : 'NEW'
        : staged.job_origin_kind === 'BACKFILL'
          ? 'BACKFILL'
          : 'NEW';
    const dedup = await jobDedup(context.ownerId, {
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
      origin_kind: origin,
      payload: {},
      priority: origin === 'BACKFILL' ? 20 : 80,
      due_at: at,
    });
    const state =
      item.availability === 'LIVE'
        ? 'DEFERRED'
        : item.availability === 'PUBLIC'
          ? 'PENDING'
          : 'BLOCKED';
    const reason =
      state === 'DEFERRED'
        ? 'LIVE_ACTIVE'
        : state === 'BLOCKED'
          ? 'SOURCE_ACCESS'
          : null;
    const due =
      state === 'DEFERRED'
        ? new Date(now.getTime() + 3600000).toISOString()
        : at;
    statements.push(
      db
        .prepare(
          `INSERT INTO discovery_scan_members(owner_id,scan_id,item_id)
        SELECT owner_id,?,item_id FROM items WHERE owner_id=? AND source_id=? AND namespace=? AND external_id=? AND ${permit.predicate}
        ON CONFLICT(owner_id,scan_id,item_id) DO NOTHING`,
        )
        .bind(
          scan.scan_id,
          context.ownerId,
          scan.source_id,
          item.namespace,
          item.external_id,
          ...permit.bindings,
        ),
      db
        .prepare(
          `INSERT INTO jobs(job_id,owner_id,item_id,source_id,task_type,input_revision,profile_revision,routing_policy_version,explicit_run_nonce,dedup_key,state,reason_code,due_at,priority,arrival_origin_at,origin_kind,payload_json,created_at,updated_at)
        SELECT ?,owner_id,item_id,source_id,'FETCH_TRANSCRIPT','source-intake-1','economy-1','local-primary-1','',?,?,?,?,?,?,?,'{}',?,? FROM items WHERE owner_id=? AND source_id=? AND namespace=? AND external_id=? AND NOT EXISTS(SELECT 1 FROM retention_items t WHERE t.owner_id=items.owner_id AND t.item_id=items.item_id AND t.phase IN ('PRUNING','COMPLETE')) AND ${permit.predicate}
        ON CONFLICT(owner_id,dedup_key) DO NOTHING`,
        )
        .bind(
          crypto.randomUUID(),
          dedup,
          state,
          reason,
          due,
          origin === 'BACKFILL' ? 20 : 80,
          item.published_at ?? at,
          origin,
          at,
          at,
          context.ownerId,
          scan.source_id,
          item.namespace,
          item.external_id,
          ...permit.bindings,
        ),
      db
        .prepare(
          `UPDATE jobs SET state='PENDING',reason_code=NULL,due_at=?,updated_at=? WHERE owner_id=? AND dedup_key=? AND state IN ('BLOCKED','DEFERRED') AND reason_code IN ('SOURCE_ACCESS','LIVE_ACTIVE') AND ?='PUBLIC' AND ${permit.predicate}`,
        )
        .bind(
          at,
          at,
          context.ownerId,
          dedup,
          item.availability,
          ...permit.bindings,
        ),
      db
        .prepare(
          `INSERT INTO outbox(event_id,owner_id,event_key,job_id,payload_json,due_at)
        SELECT ?,owner_id,'job:'||job_id||':0',job_id,json_object('job_id',job_id,'fencing_hint',NULL,'task_type',task_type),due_at FROM jobs WHERE owner_id=? AND dedup_key=? AND state='PENDING' AND ${permit.predicate}
        ON CONFLICT(owner_id,event_key) DO NOTHING`,
        )
        .bind(crypto.randomUUID(), context.ownerId, dedup, ...permit.bindings),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE discovery_scans SET cursor=?,page_revision=page_revision+1,pages_committed=pages_committed+?,enumerated_count=(SELECT COUNT(*) FROM discovery_scan_members WHERE owner_id=? AND scan_id=?),coverage=?,last_page_hash=?,completed_at=?,page_offset=?,staged_page_json=?,staged_next_cursor=?,staged_page_hash=? WHERE owner_id=? AND scan_id=? AND ${permit.predicate}`,
      )
      .bind(
        cursorAfter,
        pageFinished ? 1 : 0,
        context.ownerId,
        scan.scan_id,
        scanComplete ? 'COMPLETE' : 'PARTIAL',
        staged.staged_page_hash,
        scanComplete ? at : null,
        pageFinished ? 0 : offsetAfter,
        pageFinished ? null : staged.staged_page_json,
        pageFinished ? null : staged.staged_next_cursor,
        pageFinished ? null : staged.staged_page_hash,
        context.ownerId,
        scan.scan_id,
        ...permit.bindings,
      ),
    db
      .prepare(
        `UPDATE sources SET last_attempt_at=?,last_success_at=?,last_complete_window_end=CASE WHEN ?=1 AND (last_complete_window_end IS NULL OR last_complete_window_end<?) THEN ? ELSE last_complete_window_end END WHERE owner_id=? AND source_id=? AND ${permit.predicate}`,
      )
      .bind(
        at,
        at,
        scanComplete ? 1 : 0,
        scan.window_end,
        scan.window_end,
        context.ownerId,
        scan.source_id,
        ...permit.bindings,
      ),
    db
      .prepare(
        `INSERT INTO change_log(owner_id,component,target_id,event_type,created_at) SELECT owner_id,'discovery',scan_id,?,? FROM discovery_scans WHERE owner_id=? AND scan_id=? AND ${permit.predicate}`,
      )
      .bind(
        scanComplete
          ? 'WINDOW_COMPLETED'
          : pageFinished
            ? 'PAGE_COMMITTED'
            : 'PAGE_CHUNK_COMMITTED',
        at,
        context.ownerId,
        scan.scan_id,
        ...permit.bindings,
      ),
    db
      .prepare(
        `UPDATE job_attempts SET finished_at=?,commit_nonce=? WHERE owner_id=? AND job_id=? AND fencing_token=? AND ${permit.predicate}`,
      )
      .bind(
        at,
        nonce,
        context.ownerId,
        token.job_id,
        token.fencing_token,
        ...permit.bindings,
      ),
    db
      .prepare(
        `UPDATE jobs SET state=?,reason_code=?,due_at=?,updated_at=?,lease_owner=NULL,lease_until=NULL WHERE owner_id=? AND job_id=? AND ${permit.predicate} RETURNING job_id`,
      )
      .bind(
        jobDone ? 'SUCCEEDED' : 'DEFERRED',
        jobDone ? null : 'CONTINUATION',
        at,
        at,
        context.ownerId,
        token.job_id,
        ...permit.bindings,
      ),
  );
  const results = await db.batch(statements);
  if (results[0]?.meta.changes !== 1 || results.at(-1)?.results?.length !== 1) {
    if (results.some((result) => result.meta.changes !== 0))
      throw new Error('DISCOVERY_COMMIT_INVARIANT_FAILED');
    throw new Error('STALE_FENCE');
  }
  return {
    coverage: scanComplete ? 'COMPLETE' : 'PARTIAL',
    continuation: !jobDone,
    pages: scan.page_revision + 1,
  };
}
