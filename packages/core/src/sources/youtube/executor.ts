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
import { pollRss, RssUnavailableError } from './rss.js';
import { YoutubeClient, YoutubeError } from './client.js';
import { leasePredicate } from '../../jobs/lease-guard.js';
export async function executeDiscoveryChunk(
  db: Database,
  context: AccessContext,
  token: LeaseToken,
  client: YoutubeClient,
  now: Date,
  task: TaskType = 'DISCOVER',
  clock: () => Date = () => now,
  chunkSize = 5,
  rssFetcher: typeof fetch = fetch,
) {
  context.requireTask(task);
  let scan = await getScan(db, context, token.job_id);
  if (!scan || !['PENDING', 'PARTIAL'].includes(scan.coverage))
    throw new Error('SCAN_NOT_PENDING');
  const mode = JSON.parse(scan.job_payload_json).mode ?? 'FULL';
  if (scan.staged_page_json !== null) {
    const acquisition =
      mode === 'RSS'
        ? await db
            .prepare(
              "SELECT event_type FROM change_log WHERE owner_id=? AND component='discovery' AND target_id=? AND event_type IN ('RSS_PAGE_ACQUIRED','RSS_FALLBACK_PAGE_ACQUIRED') ORDER BY seq DESC LIMIT 1",
            )
            .bind(context.ownerId, scan.scan_id)
            .first<{ event_type: string }>()
        : null;
    return commitDiscoveryPage(
      db,
      context,
      token,
      scan,
      [],
      null,
      clock(),
      task,
      chunkSize,
      acquisition?.event_type === 'RSS_FALLBACK_PAGE_ACQUIRED'
        ? 'RSS_FALLBACK_UPLOADS'
        : acquisition
          ? 'RSS'
          : undefined,
    );
  }
  const source = await db
    .prepare(
      `SELECT s.namespace,s.external_id,s.canonical_locator,c.title,c.uploads_playlist_id,c.handle_snapshot FROM sources s JOIN channels c USING(owner_id,source_id) WHERE s.owner_id=? AND s.source_id=? AND s.enabled=1`,
    )
    .bind(context.ownerId, scan.source_id)
    .first<SourceIdentity & { handle_snapshot: string | null }>();
  if (!source) throw new Error('SOURCE_DISABLED');
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
      chunkSize,
    );
  }
  if (mode === 'RSS') {
    const state = await db
      .prepare(
        'SELECT rss_etag,rss_modified FROM sources WHERE owner_id=? AND source_id=?',
      )
      .bind(context.ownerId, scan.source_id)
      .first<{ rss_etag: string | null; rss_modified: string | null }>();
    const acquisitionScanId = scan.scan_id;
    const recordAcquisition = async (event: string) => {
      const at = clock().toISOString(),
        guard = leasePredicate(context, token, at, task);
      const receipt = await db
        .prepare(
          `INSERT INTO change_log(owner_id,component,target_id,event_type,created_at)
         SELECT owner_id,'discovery',scan_id,?,? FROM discovery_scans WHERE owner_id=? AND scan_id=? AND job_id=? AND ${guard.predicate}`,
        )
        .bind(
          event,
          at,
          context.ownerId,
          acquisitionScanId,
          token.job_id,
          ...guard.bindings,
        )
        .run();
      if (receipt.meta.changes !== 1) throw new Error('STALE_FENCE');
    };
    let rss;
    try {
      rss = await pollRss(
        source.external_id,
        state?.rss_etag ?? null,
        state?.rss_modified ?? null,
        rssFetcher,
      );
    } catch (error) {
      if (!(error instanceof RssUnavailableError)) throw error;
      await recordAcquisition(`RSS_UNAVAILABLE_${error.status}`);
      // Reuse one bounded uploads HEAD, never a historical/paginated backfill.
      const page = await enumeratePage(
        client,
        { ...source, handle: source.handle_snapshot },
        null,
      );
      // NEW_ONLY must fail closed when no authoritative publication date exists.
      if (
        scan.window_start >= scan.source_activated_at &&
        page.candidates.some((item) => item.published_at === null)
      )
        throw new YoutubeError('PARSER');
      await recordAcquisition('RSS_FALLBACK_PAGE_ACQUIRED');
      return commitDiscoveryPage(
        db,
        context,
        token,
        scan,
        page.candidates,
        null,
        clock(),
        task,
        chunkSize,
        'RSS_FALLBACK_UPLOADS',
      );
    }
    const candidates = await fetchVideoMetadata(client, source, rss.hint_ids);
    await recordAcquisition('RSS_PAGE_ACQUIRED');
    const result = await commitDiscoveryPage(
      db,
      context,
      token,
      scan,
      candidates,
      null,
      clock(),
      task,
      chunkSize,
      'RSS',
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
    chunkSize,
  );
}
