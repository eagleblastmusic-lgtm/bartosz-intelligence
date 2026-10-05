import type { AccessContext, Database } from '../../db/boundary.js';
import type { LeaseToken, TaskType } from '../../../../contracts/src/jobs.js';
import type { SourceIdentity } from '../../../../contracts/src/discovery.js';
import type { ItemMetadata } from '../../../../contracts/src/discovery.js';
import {
  getScan,
  commitDiscoveryPage,
  restartExpiredCursor,
} from './discovery.js';
import { enumeratePage, fetchVideoMetadata } from './preview.js';
import { pollRss } from './rss.js';
import { YoutubeClient, YoutubeError } from './client.js';
export async function executeDiscoveryChunk(
  db: Database,
  context: AccessContext,
  token: LeaseToken,
  client: YoutubeClient,
  now: Date,
  task: TaskType = 'DISCOVER',
  clock: () => Date = () => now,
) {
  context.requireTask(task);
  let scan = await getScan(db, context, token.job_id);
  if (!scan || !['PENDING', 'PARTIAL'].includes(scan.coverage))
    throw new Error('SCAN_NOT_PENDING');
  if (scan.staged_page_json !== null)
    return commitDiscoveryPage(
      db,
      context,
      token,
      scan,
      [],
      null,
      clock(),
      task,
    );
  const source = await db
    .prepare(
      `SELECT s.namespace,s.external_id,s.canonical_locator,c.title,c.uploads_playlist_id,c.handle_snapshot FROM sources s JOIN channels c USING(owner_id,source_id) WHERE s.owner_id=? AND s.source_id=? AND s.enabled=1`,
    )
    .bind(context.ownerId, scan.source_id)
    .first<SourceIdentity & { handle_snapshot: string | null }>();
  if (!source) throw new Error('SOURCE_DISABLED');
  const mode = JSON.parse(scan.job_payload_json).mode ?? 'FULL';
  if (mode === 'REFRESH') {
    const payload = JSON.parse(scan.job_payload_json) as {
      ids: string[];
      last_known: ItemMetadata[];
    };
    const candidates = await fetchVideoMetadata(client, source, payload.ids);
    const merged = candidates.map((item) => {
      if (item.availability !== 'UNKNOWN') return item;
      const old = payload.last_known.find(
        (previous) => previous.external_id === item.external_id,
      );
      return old
        ? {
            ...old,
            availability: 'UNKNOWN' as const,
            publication_provenance: `last_known:${old.publication_provenance}`,
          }
        : item;
    });
    return commitDiscoveryPage(
      db,
      context,
      token,
      scan,
      merged,
      null,
      clock(),
      task,
    );
  }
  if (mode === 'RSS') {
    const state = await db
      .prepare(
        'SELECT rss_etag,rss_modified FROM sources WHERE owner_id=? AND source_id=?',
      )
      .bind(context.ownerId, scan.source_id)
      .first<{ rss_etag: string | null; rss_modified: string | null }>();
    const rss = await pollRss(
      source.external_id,
      state?.rss_etag ?? null,
      state?.rss_modified ?? null,
    );
    const candidates = await fetchVideoMetadata(client, source, rss.hint_ids);
    const result = await commitDiscoveryPage(
      db,
      context,
      token,
      scan,
      candidates,
      null,
      clock(),
      task,
    );
    await db
      .prepare(
        `UPDATE sources SET rss_etag=?,rss_modified=?,last_rss_at=? WHERE owner_id=? AND source_id=? AND (last_rss_at IS NULL OR last_rss_at<=?)
         AND EXISTS(SELECT 1 FROM jobs WHERE owner_id=? AND job_id=? AND state='SUCCEEDED' AND fencing_token=?)`,
      )
      .bind(
        rss.etag,
        rss.modified,
        now.toISOString(),
        context.ownerId,
        scan.source_id,
        now.toISOString(),
        context.ownerId,
        token.job_id,
        token.fencing_token,
      )
      .run();
    return result;
  }
  let page;
  try {
    page = await enumeratePage(
      client,
      { ...source, handle: source.handle_snapshot },
      scan.cursor,
    );
  } catch (error) {
    if (!(error instanceof YoutubeError) || error.code !== 'INVALID_CURSOR')
      throw error;
    await restartExpiredCursor(db, context, token, scan, clock(), task);
    scan = (await getScan(db, context, token.job_id))!;
    page = await enumeratePage(
      client,
      { ...source, handle: source.handle_snapshot },
      null,
    );
  }
  return commitDiscoveryPage(
    db,
    context,
    token,
    scan,
    page.candidates,
    page.next_cursor,
    clock(),
    task,
  );
}
