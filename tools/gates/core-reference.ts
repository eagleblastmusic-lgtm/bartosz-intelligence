import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { YoutubeClient } from '../../packages/core/src/sources/youtube/client.js';
// Independent enumeration: do not reuse the discovery producer's mapper or traversal.
// Private checkpoint avoids repeating live enumeration when only comparison is pending.
const { query } = await import('../deployment/cloudflare.mjs');
const directory = '.local/core-acceptance';
mkdirSync(directory, { recursive: true });
const privatePath = `${directory}/reference.json`;
const hash = (input: unknown) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');
type Reference = {
  source_id: string;
  scan_id: string;
  owner_id: string;
  channel_id: string;
  playlist: string;
  window_start: string;
  window_end: string;
  pages: number;
  requests: number;
  ids: string[];
  unknown_ids: string[];
  sampled_at: string;
  complete: boolean;
};
let reference: Reference;
if (process.argv[2] === 'collect') {
  if (!process.env.YOUTUBE_API_KEY)
    throw new Error('PROVIDER_CONFIGURATION_REQUIRED');
  const rows = (
    await query<
      Pick<
        Reference,
        | 'source_id'
        | 'owner_id'
        | 'channel_id'
        | 'playlist'
        | 'scan_id'
        | 'window_start'
        | 'window_end'
      >
    >(
      `SELECT s.source_id,s.owner_id,c.youtube_channel_id channel_id,c.uploads_playlist_id playlist,d.scan_id,d.window_start,d.window_end FROM sources s JOIN channels c USING(owner_id,source_id) JOIN discovery_scans d USING(owner_id,source_id) JOIN jobs j ON j.owner_id=d.owner_id AND j.job_id=d.job_id WHERE COALESCE(json_extract(j.payload_json,'$.mode'),'FULL')='FULL' ORDER BY d.started_at LIMIT 1`,
    )
  )[0]!.results;
  if (rows.length !== 1) throw new Error('REAL_FULL_SCAN_REQUIRED');
  reference = {
    ...rows[0]!,
    pages: 0,
    requests: 0,
    ids: [],
    unknown_ids: [],
    sampled_at: new Date().toISOString(),
    complete: false,
  };
  let cursor: string | null = null;
  const ids = new Set<string>(),
    unknown = new Set<string>(),
    cursors = new Set<string>();
  do {
    if (reference.requests + 2 > 400)
      throw new Error('REFERENCE_REQUEST_BUDGET');
    const client = new YoutubeClient(process.env.YOUTUBE_API_KEY, 2);
    const page = await client.get('playlistItems', {
      part: 'contentDetails',
      playlistId: reference.playlist,
      maxResults: '50',
      ...(cursor ? { pageToken: cursor } : {}),
    });
    const pageIds = (
      page.items as { contentDetails: { videoId: string } }[]
    ).map((item) => item.contentDetails.videoId);
    if (pageIds.length > 50 || pageIds.some((id) => !/^[\w-]{11}$/.test(id)))
      throw new Error('REFERENCE_PARSER');
    const metadata = pageIds.length
      ? await client.get('videos', {
          part: 'snippet,status',
          id: [...new Set(pageIds)].join(','),
        })
      : { items: [] };
    for (const video of metadata.items as {
      id: string;
      snippet: { channelId: string; publishedAt?: string };
    }[]) {
      if (
        !pageIds.includes(video.id) ||
        video.snippet.channelId !== reference.channel_id
      )
        throw new Error('REFERENCE_PARSER');
      const date = video.snippet.publishedAt;
      if (!date || !Number.isFinite(Date.parse(date))) {
        unknown.add(video.id);
        continue;
      }
      const canonicalDate = new Date(date).toISOString();
      if (
        canonicalDate >= reference.window_start &&
        canonicalDate <= reference.window_end
      )
        ids.add(video.id);
    }
    reference.pages++;
    reference.requests += client.usage.requests;
    if (
      page.nextPageToken !== undefined &&
      typeof page.nextPageToken !== 'string'
    )
      throw new Error('REFERENCE_PARSER');
    cursor = typeof page.nextPageToken === 'string' ? page.nextPageToken : null;
    if (cursor && cursors.has(cursor))
      throw new Error('REFERENCE_CURSOR_CYCLE');
    if (cursor) cursors.add(cursor);
    reference.ids = [...ids].sort();
    reference.unknown_ids = [...unknown].sort();
    reference.complete = cursor === null;
    writeFileSync(privatePath, JSON.stringify(reference), { mode: 0o600 });
    if (reference.pages % 20 === 0)
      console.log(
        JSON.stringify({
          pages: reference.pages,
          requests: reference.requests,
          reference_ids: ids.size,
          status: 'ENUMERATING',
        }),
      );
  } while (cursor);
  console.log(
    JSON.stringify({
      status: 'REFERENCE_COMPLETE',
      pages: reference.pages,
      requests: reference.requests,
      reference_ids: reference.ids.length,
      unknown_publication: reference.unknown_ids.length,
    }),
  );
} else {
  reference = JSON.parse(readFileSync(privatePath, 'utf8')) as Reference;
  if (!reference.complete) throw new Error('REFERENCE_NOT_COMPLETE');
  const scan = (
    await query<{
      coverage: string;
      pages_committed: number;
      enumerated_count: number;
    }>(
      'SELECT coverage,pages_committed,enumerated_count FROM discovery_scans WHERE owner_id=? AND scan_id=?',
      [reference.owner_id, reference.scan_id],
    )
  )[0]!.results[0]!;
  const members = (
    await query<{ external_id: string; item_id: string }>(
      'SELECT i.external_id,i.item_id FROM discovery_scan_members m JOIN items i USING(owner_id,item_id) WHERE m.owner_id=? AND m.scan_id=? ORDER BY i.external_id',
      [reference.owner_id, reference.scan_id],
    )
  )[0]!.results;
  const actual = members.map(
    (item: { external_id: string }) => item.external_id,
  );
  const jobs = (
    await query<{ external_id: string }>(
      "SELECT DISTINCT i.external_id FROM jobs j JOIN items i USING(owner_id,item_id) WHERE j.owner_id=? AND j.task_type='FETCH_TRANSCRIPT' AND i.source_id=? ORDER BY i.external_id",
      [reference.owner_id, reference.source_id],
    )
  )[0]!.results.map((row) => row.external_id);
  const watermark = (
    await query<{ last_complete_window_end: string | null }>(
      'SELECT last_complete_window_end FROM sources WHERE owner_id=? AND source_id=?',
      [reference.owner_id, reference.source_id],
    )
  )[0]!.results[0]!.last_complete_window_end;
  const result =
    scan.coverage === 'COMPLETE' &&
    hash(actual) === hash(reference.ids) &&
    reference.ids.every((id) => jobs.includes(id)) &&
    watermark !== null &&
    watermark >= reference.window_end
      ? 'PASS'
      : 'NOT_YET_COMPLETE';
  const report = {
    sampled_at: new Date().toISOString(),
    result,
    window: { start: reference.window_start, end: reference.window_end },
    reference: {
      pages: reference.pages,
      requests: reference.requests,
      ids: reference.ids,
      sha256: hash(reference.ids),
      unknown_publication: reference.unknown_ids.length,
    },
    actual: {
      ...scan,
      ids: actual,
      sha256: hash(actual),
      missing_job_ids: reference.ids.filter((id) => !jobs.includes(id)),
      watermark,
    },
    paid_services_enabled: false,
    provider_generation_requests: 0,
  };
  mkdirSync('docs/verification/core-acceptance', { recursive: true });
  const path = `docs/verification/core-acceptance/reference-${report.sampled_at.replaceAll(':', '-')}.json`;
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(
    JSON.stringify({
      result,
      evidence_ref: path,
      reference_ids: reference.ids.length,
      actual_ids: actual.length,
      coverage: scan.coverage,
    }),
  );
}
