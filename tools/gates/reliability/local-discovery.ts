import { randomUUID } from 'node:crypto';
import {
  AccessContext,
  type Database,
} from '../../../packages/core/src/db/boundary.js';
import { sha256, randomToken } from '../../../packages/core/src/auth/crypto.js';
import {
  addSource,
  backfillWindow,
} from '../../../packages/core/src/sources/youtube/backfill.js';
import {
  getScan,
  commitDiscoveryPage,
} from '../../../packages/core/src/sources/youtube/discovery.js';
import { JobStore } from '../../../packages/core/src/jobs/store.js';
import { sweep } from '../../../packages/core/src/jobs/recovery.js';
import type { ItemMetadata } from '../../../packages/contracts/src/discovery.js';

// Caller supplies an already isolated local D1. Synthetic metadata exercises
// durable discovery correctness, never actual YouTube enumeration or fidelity.
export async function drillDiscovery(
  db: Database,
  owner: AccessContext,
  now: Date,
) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 22);
  const channel = 'UC' + suffix;
  const window = backfillWindow(now);
  const intent = await addSource(
    db,
    owner,
    {
      namespace: 'youtube',
      external_id: channel,
      canonical_locator: 'https://www.youtube.com/channel/' + channel,
      title: 'Isolated recovery drill',
      uploads_playlist_id: 'UU' + suffix,
      handle: null,
    },
    randomUUID(),
    window,
    now,
  );
  const credential = await sha256(randomToken());
  const workerId = 'discovery-' + randomUUID();
  await db
    .prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      workerId,
      owner.ownerId,
      credential,
      '["DISCOVER"]',
      now.toISOString(),
    )
    .run();
  const context = await AccessContext.worker(db, credential);
  const store = new JobStore(db, context);
  const initial = (await store.get(intent.job_id))!;
  const lease = async (at: Date) => {
    await sweep(db, at, () => true);
    const token = await store.lease(intent.job_id, 'DISCOVER', at, 'local');
    if (!token) throw new Error('DISCOVERY_DRILL_LEASE_REQUIRED');
    await store.start(token, 'DISCOVER', at);
    return token;
  };
  const ids = ['A', 'B'].map((prefix) => prefix + suffix.slice(0, 10));
  const item = (id: string): ItemMetadata => ({
    namespace: 'youtube',
    external_id: id,
    canonical_url: 'https://www.youtube.com/watch?v=' + id,
    title: 'Synthetic discovery metadata',
    item_type: 'video',
    published_at: new Date(now.getTime() - 86400000).toISOString(),
    publication_provenance: 'videos.snippet.publishedAt',
    availability: 'PUBLIC',
    duration_seconds: 60,
  });
  let token = await lease(now);
  await commitDiscoveryPage(
    db,
    context,
    token,
    (await getScan(db, context, intent.job_id))!,
    [item(ids[0]!), item(ids[0]!)],
    'second-page',
    now,
  );
  token = await lease(now);
  let rejected = false;
  try {
    await commitDiscoveryPage(
      {
        prepare: db.prepare.bind(db),
        batch: (statements) =>
          db.batch([
            ...statements,
            db.prepare(
              'INSERT INTO isolated_discovery_missing_table VALUES(1)',
            ),
          ]),
      },
      context,
      token,
      (await getScan(db, context, intent.job_id))!,
      [item(ids[1]!)],
      null,
      now,
    );
  } catch {
    rejected = true;
  }
  const watermarkBefore = await db
    .prepare('SELECT last_complete_window_end FROM sources WHERE source_id=?')
    .bind(intent.source_id)
    .first<string>('last_complete_window_end');
  const countItems = async () =>
    db
      .prepare('SELECT COUNT(*) n FROM items WHERE source_id=?')
      .bind(intent.source_id)
      .first<number>('n');
  const before = await countItems();
  const later = new Date(now.getTime() + 16 * 60000);
  const resumed = await lease(later);
  let staleRejected = false;
  try {
    await commitDiscoveryPage(
      db,
      context,
      token,
      (await getScan(db, context, intent.job_id))!,
      [],
      null,
      later,
    );
  } catch (error) {
    staleRejected = error instanceof Error && error.message === 'STALE_FENCE';
  }
  await commitDiscoveryPage(
    db,
    context,
    resumed,
    (await getScan(db, context, intent.job_id))!,
    [],
    null,
    later,
  );
  const final = (await store.get(intent.job_id))!;
  const after = await countItems();
  const jobs = await db
    .prepare(
      "SELECT COUNT(*) n FROM jobs WHERE source_id=? AND task_type='FETCH_TRANSCRIPT'",
    )
    .bind(intent.source_id)
    .first<number>('n');
  const watermarkAfter = await db
    .prepare('SELECT last_complete_window_end FROM sources WHERE source_id=?')
    .bind(intent.source_id)
    .first<string>('last_complete_window_end');
  await db
    .prepare('UPDATE worker_identities SET revoked_at=? WHERE worker_id=?')
    .bind(later.toISOString(), workerId)
    .run();
  return {
    pass:
      rejected &&
      staleRejected &&
      watermarkBefore === null &&
      before === 1 &&
      after === 2 &&
      jobs === 2 &&
      watermarkAfter === window.window_end &&
      final.arrival_origin_at === initial.arrival_origin_at &&
      final.origin_kind === initial.origin_kind,
    observations: {
      batch_rejected: rejected,
      stale_rejected: staleRejected,
      items_before_recovery: before,
      items_after_recovery: after,
      transcript_jobs: jobs,
      watermark_advanced_after_recovery: watermarkAfter === window.window_end,
    },
  };
}
