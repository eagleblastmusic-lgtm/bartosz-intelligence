import { it, expect } from 'vitest';
import {
  normalizeLocator,
  resolveSource,
} from '../../packages/core/src/sources/youtube/resolver.js';
import { YoutubeClient } from '../../packages/core/src/sources/youtube/client.js';
import { backfillWindow } from '../../packages/core/src/sources/youtube/backfill.js';
import { previewBackfill } from '../../packages/core/src/sources/youtube/preview.js';
const channel = 'UC' + 'a'.repeat(22),
  playlist = 'UU' + 'a'.repeat(22);
it('locator normalization rejects internal hosts, credentials, unsupported paths and arbitrary redirects', () => {
  expect(normalizeLocator(channel)).toEqual(
    normalizeLocator(`https://www.youtube.com/channel/${channel}`),
  );
  expect(normalizeLocator('@fixture')).toEqual(
    normalizeLocator('https://youtube.com/@fixture/videos'),
  );
  for (const bad of [
    'http://youtube.com/@fixture',
    'https://youtube.com.evil.example/@fixture',
    'https://127.0.0.1/@fixture',
    'https://user@youtube.com/@fixture',
    'https://youtube.com:444/@fixture',
    'https://youtube.com/playlist?list=anything',
  ])
    expect(() => normalizeLocator(bad)).toThrow('INVALID_LOCATOR');
});
it('public resolver uses channels forHandle, resolves equivalent identity and redacts transport errors', async () => {
  const fake: typeof fetch = async (input, init) => {
    expect(init?.redirect).toBe('error');
    const url = new URL(input as string);
    expect(url.pathname).toBe('/youtube/v3/channels');
    expect(url.searchParams.get('forHandle')).toBe('@fixture');
    return Response.json({
      items: [
        {
          id: channel,
          snippet: { title: 'Fixture', customUrl: '@fixture' },
          contentDetails: { relatedPlaylists: { uploads: playlist } },
        },
      ],
    });
  };
  expect(
    (await resolveSource(new YoutubeClient('fixture-key', 2, fake), '@fixture'))
      .external_id,
  ).toBe(channel);
  const failure: typeof fetch = async () => {
    throw new Error('secret-in-transport');
  };
  await expect(
    resolveSource(new YoutubeClient('fixture-key', 2, failure), '@fixture'),
  ).rejects.toThrow('TRANSIENT');
});
it('30 days default, only-new cutoff and bounded custom windows are explicit', () => {
  const now = new Date('2026-10-05T00:00:00Z');
  expect(backfillWindow(now).window_start).toBe('2026-09-05T00:00:00.000Z');
  expect(backfillWindow(now, 'only-new').window_start).toBe(now.toISOString());
  expect(() =>
    backfillWindow(now, 'custom', '2026-10-06', '2026-10-07'),
  ).toThrow('INVALID_WINDOW');
});
it('preview uses publication window, reports partial coverage and never playlist total', async () => {
  const fake: typeof fetch = async (input) => {
    const url = new URL(input as string);
    return url.pathname.endsWith('playlistItems')
      ? Response.json({
          pageInfo: { totalResults: 5000 },
          items: [
            {
              contentDetails: {
                videoId: 'a'.repeat(11),
                videoPublishedAt: '2026-10-01T00:00:00Z',
              },
            },
            {
              contentDetails: {
                videoId: 'b'.repeat(11),
                videoPublishedAt: '2026-01-01T00:00:00Z',
              },
            },
          ],
          nextPageToken: 'page-2',
        })
      : Response.json({
          items: ['a', 'b'].map((id) => ({
            id: id.repeat(11),
            snippet: {
              title: id,
              channelId: channel,
              publishedAt:
                id === 'a' ? '2026-10-01T00:00:00Z' : '2026-01-01T00:00:00Z',
            },
            contentDetails: { duration: 'PT2M' },
            status: { privacyStatus: 'public' },
          })),
        });
  };
  const result = await previewBackfill(
    new YoutubeClient('fixture-key', 2, fake),
    {
      namespace: 'youtube',
      external_id: channel,
      canonical_locator: `https://www.youtube.com/channel/${channel}`,
      title: 'Fixture',
      uploads_playlist_id: playlist,
      handle: '@fixture',
    },
    backfillWindow(new Date('2026-10-05')),
    1,
  );
  expect(result.coverage).toBe('PARTIAL');
  expect(result.enumerated_count).toBe(1);
  expect(result.known_duration_seconds).toBe(120);
});
