import { YoutubeClient, record, string, YoutubeError } from './client.js';
import type {
  SourceIdentity,
  ItemMetadata,
} from '../../../../contracts/src/discovery.js';
export function durationSeconds(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match =
    /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
  if (!match || !match.slice(1).some(Boolean)) return null;
  return (
    Number(match[1] ?? 0) * 86400 +
    Number(match[2] ?? 0) * 3600 +
    Number(match[3] ?? 0) * 60 +
    Number(match[4] ?? 0)
  );
}
export async function enumeratePage(
  client: YoutubeClient,
  identity: SourceIdentity,
  cursor: string | null,
) {
  if (cursor !== null && (cursor.length > 2048 || !cursor))
    throw new Error('INVALID_CURSOR');
  const uploads = await client.get('playlistItems', {
    part: 'contentDetails',
    playlistId: identity.uploads_playlist_id,
    maxResults: '50',
    ...(cursor ? { pageToken: cursor } : {}),
  });
  const entries = uploads.items as unknown[];
  if (
    entries.length > 50 ||
    (uploads.nextPageToken !== undefined &&
      typeof uploads.nextPageToken !== 'string')
  )
    throw new YoutubeError('PARSER');
  const published = new Map<string, string | null>();
  const ids = entries.map((entry) => {
    const details = record(record(entry).contentDetails),
      id = string(details.videoId);
    if (!/^[\w-]{11}$/.test(id)) throw new YoutubeError('PARSER');
    published.set(
      id,
      typeof details.videoPublishedAt === 'string' &&
        Number.isFinite(Date.parse(details.videoPublishedAt))
        ? new Date(details.videoPublishedAt).toISOString()
        : null,
    );
    return id;
  });
  const candidates = await fetchVideoMetadata(client, identity, ids, published);
  return {
    candidates,
    next_cursor:
      typeof uploads.nextPageToken === 'string' ? uploads.nextPageToken : null,
    ordering_guarantee: 'unknown' as const,
    coverage: uploads.nextPageToken
      ? ('PARTIAL' as const)
      : ('COMPLETE' as const),
  };
}
export async function fetchVideoMetadata(
  client: YoutubeClient,
  identity: SourceIdentity,
  ids: string[],
  published = new Map<string, string | null>(),
) {
  if (ids.length > 50 || ids.some((id) => !/^[\w-]{11}$/.test(id)))
    throw new YoutubeError('PARSER');
  const videos = ids.length
    ? await client.get('videos', {
        part: 'snippet,contentDetails,status,liveStreamingDetails',
        id: [...new Set(ids)].join(','),
      })
    : { items: [] };
  const byId = new Map<string, ItemMetadata>();
  for (const entry of videos.items as unknown[]) {
    const video = record(entry),
      id = string(video.id),
      snippet = record(video.snippet);
    if (!ids.includes(id) || snippet.channelId !== identity.external_id)
      throw new YoutubeError('PARSER');
    const status = record(video.status),
      live =
        typeof video.liveStreamingDetails === 'object'
          ? record(video.liveStreamingDetails)
          : null;
    const pub =
      typeof snippet.publishedAt === 'string' &&
      Number.isFinite(Date.parse(snippet.publishedAt))
        ? new Date(snippet.publishedAt).toISOString()
        : (published.get(id) ?? null);
    const active =
      snippet.liveBroadcastContent === 'live' ||
      snippet.liveBroadcastContent === 'upcoming';
    byId.set(id, {
      namespace: 'youtube',
      external_id: id,
      item_type: live ? 'live' : 'unknown',
      canonical_url: `https://www.youtube.com/watch?v=${id}`,
      title: string(snippet.title),
      published_at: pub,
      publication_provenance:
        typeof snippet.publishedAt === 'string' &&
        Number.isFinite(Date.parse(snippet.publishedAt))
          ? 'videos.snippet.publishedAt'
          : pub
            ? 'playlist.contentDetails.videoPublishedAt'
            : 'UNKNOWN',
      availability: active
        ? 'LIVE'
        : status.privacyStatus === 'public'
          ? 'PUBLIC'
          : status.privacyStatus === 'private'
            ? 'PRIVATE'
            : 'UNKNOWN',
      duration_seconds: durationSeconds(record(video.contentDetails).duration),
    });
  }
  const candidates = [...new Set(ids)].map(
    (id) =>
      byId.get(id) ?? {
        namespace: 'youtube',
        external_id: id,
        item_type: 'unknown' as const,
        canonical_url: `https://www.youtube.com/watch?v=${id}`,
        title: 'Metadata unavailable',
        published_at: published.get(id) ?? null,
        publication_provenance: published.get(id)
          ? 'playlist.contentDetails.videoPublishedAt'
          : 'UNKNOWN',
        availability: 'UNKNOWN' as const,
        duration_seconds: null,
      },
  );
  return candidates;
}
export async function previewBackfill(
  client: YoutubeClient,
  identity: SourceIdentity,
  window: { window_start: string; window_end: string },
  maxPages = 3,
  cursor: string | null = null,
) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5)
    throw new Error('INVALID_PAGE_BUDGET');
  const candidates: ItemMetadata[] = [],
    seen = new Set<string>();
  let pages = 0,
    next = cursor;
  do {
    const page = await enumeratePage(client, identity, next);
    pages++;
    for (const item of page.candidates)
      if (
        !seen.has(item.external_id) &&
        (item.published_at === null ||
          (item.published_at >= window.window_start &&
            item.published_at <= window.window_end))
      ) {
        seen.add(item.external_id);
        candidates.push(item);
      }
    next = page.next_cursor;
  } while (next !== null && pages < maxPages);
  return {
    window,
    candidates,
    pages,
    next_cursor: next,
    coverage: next === null ? ('COMPLETE' as const) : ('PARTIAL' as const),
    enumerated_count: candidates.length,
    unknown_publication_count: candidates.filter(
      (item) => item.published_at === null,
    ).length,
    known_duration_seconds: candidates.reduce(
      (sum, item) => sum + (item.duration_seconds ?? 0),
      0,
    ),
    missing_duration_count: candidates.filter(
      (item) => item.duration_seconds === null,
    ).length,
    estimated_analysis_requests: candidates.length,
    estimated_input_tokens_range: [
      candidates.length * 5000,
      candidates.length * 20000,
    ],
    cost_policy: { paid_services_enabled: false, additional_cost_pln: 0 },
    usage: client.usage,
  };
}
