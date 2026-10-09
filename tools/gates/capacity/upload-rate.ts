import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  YoutubeClient,
  YoutubeError,
  record,
} from '../../../packages/core/src/sources/youtube/client.js';

// Public publication metadata only, up to two pages/channel. No source/item
// create or backfill; no D1 access, captions or Gemini calls.
if (
  process.argv.slice(2).join(' ') !== '--approved-20 --once' ||
  !process.env.YOUTUBE_API_KEY
)
  throw new Error('EXPLICIT_APPROVED_UPLOAD_RATE_REQUIRED');
const resolved = JSON.parse(
  readFileSync(
    'docs/verification/capacity/approved-channel-identities-2026-10-09.json',
    'utf8',
  ),
);
if (
  resolved.status !== 'RESOLVED_NOT_ADDED' ||
  resolved.identities.length !== 19
)
  throw new Error('VERIFIED_APPROVED_IDENTITIES_REQUIRED');
const channels = [
  {
    title: 'TED',
    external_id: 'UCAuUUnT6oDeKwE6v1NGQxug',
    uploads_playlist_id: 'UUAuUUnT6oDeKwE6v1NGQxug',
  },
  ...resolved.identities,
] as { title: string; external_id: string; uploads_playlist_id: string }[];
if (new Set(channels.map((c) => c.external_id)).size !== 20)
  throw new Error('EXACT_20_UNIQUE_CHANNELS_REQUIRED');
const now = new Date(),
  start = new Date(now.getTime() - 28 * 86400000);
mkdirSync('.local/capacity-observation', { recursive: true });
writeFileSync(
  '.local/capacity-observation/upload-rate-intent.json',
  JSON.stringify({
    registered_at: now.toISOString(),
    max_requests: 40,
    max_pages_per_channel: 2,
    production_d1_requests: 0,
    paid_services_enabled: false,
  }) + '\n',
  { flag: 'wx' },
);
const client = new YoutubeClient(process.env.YOUTUBE_API_KEY, 40),
  samples: Record<string, unknown>[] = [];
for (const channel of channels) {
  let pages = 0,
    missing = 0,
    next: string | undefined,
    older = false,
    truncated = false;
  const publications = new Map<string, string>();
  try {
    do {
      const response = await client.get('playlistItems', {
        part: 'contentDetails',
        playlistId: channel.uploads_playlist_id,
        maxResults: '50',
        ...(next ? { pageToken: next } : {}),
      });
      pages++;
      if (!Array.isArray(response.items)) throw new YoutubeError('PARSER');
      for (const row of response.items) {
        const item = record(record(row).contentDetails),
          date = item.videoPublishedAt;
        if (
          typeof item.videoId !== 'string' ||
          typeof date !== 'string' ||
          !Number.isFinite(Date.parse(date))
        ) {
          missing++;
          continue;
        }
        if (Date.parse(date) < start.getTime()) older = true;
        else if (Date.parse(date) <= now.getTime())
          publications.set(item.videoId, date);
      }
      next =
        typeof response.nextPageToken === 'string'
          ? response.nextPageToken
          : undefined;
      truncated = Boolean(next) && !older;
    } while (next && !older && pages < 2);
    samples.push({
      channel: channel.title,
      channel_id: channel.external_id,
      pages,
      observed_publications_28d: publications.size,
      mean_daily_from_observed_window: publications.size / 28,
      window_truncated: truncated,
      missing_publication_dates: missing,
      basis:
        truncated || missing
          ? 'LOWER_BOUND_BOUNDED_PUBLIC_METADATA'
          : 'BOUNDED_UPLOADS_RECENCY_WINDOW',
      video_ids_or_titles_recorded: false,
    });
  } catch (error) {
    samples.push({
      channel: channel.title,
      channel_id: channel.external_id,
      state: 'FAILED',
      pages,
      reason: error instanceof YoutubeError ? error.code : 'METADATA_FAILED',
    });
    break;
  }
}
const total = samples.reduce(
  (n, row) => n + Number(row.observed_publications_28d ?? 0),
  0,
);
const receipt = {
  version: 'ApprovedUploadRate/1.0',
  observed_at: now.toISOString(),
  window_start: start.toISOString(),
  window_end: now.toISOString(),
  status:
    samples.length === 20 && samples.every((row) => row.state !== 'FAILED')
      ? 'MEASURED_PUBLIC_METADATA'
      : 'PARTIAL_METADATA',
  observed_publications_28d: total,
  mean_daily_from_observed_window: total / 28,
  future_rate: 'FORECAST_ONLY_NOT_GUARANTEED',
  uploads_recency_order: 'ASSUMED_FOR_WINDOW_BOUNDARY_NOT_FULL_HISTORY_CRAWL',
  truncated_channels: samples.filter((row) => row.window_truncated).length,
  channels: samples,
  youtube_usage: client.usage,
  production_d1_requests: 0,
  source_create_requests: 0,
  backfill_requests: 0,
  caption_requests: 0,
  gemini_requests: 0,
  paid_services_enabled: false,
};
mkdirSync('docs/verification/capacity', { recursive: true });
writeFileSync(
  'docs/verification/capacity/approved-upload-rate-2026-10-09.json',
  JSON.stringify(receipt, null, 2) + '\n',
  { flag: 'wx' },
);
console.log(
  JSON.stringify({
    status: receipt.status,
    observed_28d: total,
    daily_mean: total / 28,
    truncated_channels: receipt.truncated_channels,
    requests: client.usage.requests,
  }),
);
if (receipt.status !== 'MEASURED_PUBLIC_METADATA') process.exitCode = 2;
