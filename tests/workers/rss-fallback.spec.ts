import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { fixtureNow, fixtureOwner, resetCore } from './core-fixture.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { sweep } from '../../packages/core/src/jobs/recovery.js';
import {
  startMonitoringCycles,
  enrollMonitoringBatch,
  refreshMonitoringProgress,
} from '../../packages/core/src/sources/youtube/cycles.js';
import { executeDiscoveryChunk } from '../../packages/core/src/sources/youtube/executor.js';
import { YoutubeClient } from '../../packages/core/src/sources/youtube/client.js';

beforeEach(resetCore);
const channel = 'UC' + 'r'.repeat(22);
const now = new Date(fixtureNow.getTime() + 10 * 60000);
async function setup() {
  const source = (await new SourceRepository(
    env.DB,
    await fixtureOwner(),
  ).upsert(
    {
      namespace: 'youtube',
      external_id: channel,
      canonical_locator: `https://www.youtube.com/channel/${channel}`,
      title: 'Fixture',
      uploads_playlist_id: 'UU' + 'r'.repeat(22),
      handle: null,
    },
    fixtureNow.toISOString(),
  ))!;
  await startMonitoringCycles(env.DB, now);
  await enrollMonitoringBatch(env.DB, now);
  const job = (await env.DB.prepare(
    "SELECT job_id,payload_json FROM jobs WHERE task_type='DISCOVER'",
  ).first<{ job_id: string; payload_json: string }>())!;
  await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      'discovery',
      'a',
      await sha256('rss-fixture'),
      '["DISCOVER"]',
      fixtureNow.toISOString(),
    )
    .run();
  const context = await AccessContext.worker(
    env.DB,
    await sha256('rss-fixture'),
  );
  const store = new JobStore(env.DB, context);
  return {
    source,
    job,
    context,
    async lease() {
      await sweep(env.DB, now, () => true);
      const lease = (await store.lease(job.job_id, 'DISCOVER', now, 'cloud'))!;
      await store.start(lease, 'DISCOVER', now);
      return lease;
    },
  };
}
function uploads(
  entries: { id: string; published: string | null }[],
  observed: string[],
) {
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(input as string);
    observed.push(url.pathname);
    expect(url.searchParams.has('pageToken')).toBe(false);
    if (url.pathname.endsWith('playlistItems')) {
      expect(url.searchParams.get('maxResults')).toBe('50');
      return Response.json({
        items: entries.map(({ id, published }) => ({
          contentDetails: {
            videoId: id,
            ...(published ? { videoPublishedAt: published } : {}),
          },
        })),
        nextPageToken: 'must-not-page',
      });
    }
    return Response.json({
      items: [
        ...new Map(entries.map((entry) => [entry.id, entry])).values(),
      ].map(({ id, published }) => ({
        id,
        snippet: {
          channelId: channel,
          title: 'Fixture',
          ...(published ? { publishedAt: published } : {}),
          liveBroadcastContent: 'none',
        },
        contentDetails: { duration: 'PT1M' },
        status: { privacyStatus: 'public' },
      })),
    });
  };
  return fetcher;
}
it.each([404, 410] as const)(
  'HTTP %i fallback performs exactly one HEAD and NEW_ONLY imports no history',
  async (status) => {
    const { source, job, context, lease } = await setup();
    await env.DB.prepare(
      'UPDATE sources SET rss_etag=?,rss_modified=? WHERE source_id=?',
    )
      .bind('existing-etag', 'existing-modified', source.source_id)
      .run();
    const observed: string[] = [],
      client = new YoutubeClient(
        'fixture-key',
        3,
        uploads(
          Array.from({ length: 50 }, (_, i) => ({
            id: String(i).padStart(11, '0'),
            published: '2026-10-01T00:00:00.000Z',
          })),
          observed,
        ),
      );
    const result = await executeDiscoveryChunk(
      env.DB,
      context,
      await lease(),
      client,
      now,
      'DISCOVER',
      () => now,
      5,
      async () => new Response(null, { status }),
    );
    expect(result).toMatchObject({
      continuation: false,
      coverage: 'PARTIAL',
      discovery_transport: 'RSS_FALLBACK_UPLOADS',
    });
    expect(observed).toEqual([
      '/youtube/v3/playlistItems',
      '/youtube/v3/videos',
    ]);
    expect(client.usage.requests).toBe(2);
    expect(
      await env.DB.prepare('SELECT COUNT(*) n FROM items').first('n'),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM jobs WHERE task_type='FETCH_TRANSCRIPT'",
      ).first('n'),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        'SELECT rss_etag,rss_modified,last_rss_at FROM sources WHERE source_id=?',
      )
        .bind(source.source_id)
        .first(),
    ).toEqual({
      rss_etag: 'existing-etag',
      rss_modified: 'existing-modified',
      last_rss_at: null,
    });
    expect(
      await env.DB.prepare('SELECT payload_json FROM jobs WHERE job_id=?')
        .bind(job.job_id)
        .first('payload_json'),
    ).toBe(job.payload_json);
    const events = (
      await env.DB.prepare(
        "SELECT event_type FROM change_log WHERE component='discovery' AND event_type LIKE 'RSS_%' ORDER BY seq",
      ).all<{ event_type: string }>()
    ).results.map((e) => e.event_type);
    expect(events).toEqual([
      `RSS_UNAVAILABLE_${status}`,
      'RSS_FALLBACK_PAGE_ACQUIRED',
      'RSS_FALLBACK_PAGE_COMMITTED',
    ]);
    await refreshMonitoringProgress(env.DB, now);
    expect(
      await env.DB.prepare(
        'SELECT state,completed,failed FROM monitoring_cycles',
      ).first(),
    ).toEqual({ state: 'COMPLETE', completed: 1, failed: 0 });
    expect(
      await env.DB.prepare('SELECT pages_committed FROM discovery_scans').first(
        'pages_committed',
      ),
    ).toBe(1);
  },
);
it('staged fallback resumes without a second RSS/HEAD request and duplicates cannot create repeated FETCH jobs', async () => {
  const { context, lease } = await setup();
  const published = new Date(fixtureNow.getTime() + 5 * 60000).toISOString(),
    observed: string[] = [];
  const entries = [
    'newaaaaaaaa',
    'newbbbbbbbb',
    'newcccccccc',
    'newaaaaaaaa',
  ].map((id) => ({ id, published }));
  const client = new YoutubeClient(
    'fixture-key',
    3,
    uploads(entries, observed),
  );
  const first = await executeDiscoveryChunk(
    env.DB,
    context,
    await lease(),
    client,
    now,
    'DISCOVER',
    () => now,
    2,
    async () => new Response(null, { status: 404 }),
  );
  expect(first).toMatchObject({
    continuation: true,
    discovery_transport: 'RSS_FALLBACK_UPLOADS',
  });
  await refreshMonitoringProgress(env.DB, now);
  expect(
    await env.DB.prepare(
      'SELECT state,completed FROM monitoring_cycles',
    ).first(),
  ).toEqual({ state: 'RUNNING', completed: 0 });
  const noFetch: typeof fetch = async () => {
    throw new Error('unexpected additional network call');
  };
  const resumed = await executeDiscoveryChunk(
    env.DB,
    context,
    await lease(),
    new YoutubeClient('fixture-key', 3, noFetch),
    now,
    'DISCOVER',
    () => now,
    2,
    noFetch,
  );
  expect(resumed).toMatchObject({
    continuation: false,
    discovery_transport: 'RSS_FALLBACK_UPLOADS',
  });
  expect(observed).toHaveLength(2);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM items').first('n')).toBe(
    3,
  );
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE task_type='FETCH_TRANSCRIPT'",
    ).first('n'),
  ).toBe(3);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM change_log WHERE event_type='RSS_FALLBACK_PAGE_COMMITTED'",
    ).first('n'),
  ).toBe(1);
  await refreshMonitoringProgress(env.DB, now);
  expect(
    await env.DB.prepare(
      'SELECT state,completed FROM monitoring_cycles',
    ).first(),
  ).toEqual({ state: 'COMPLETE', completed: 1 });
});
it.each([429, 403, 500, 200])(
  'RSS technical failure %i never starts fallback or commits a scan',
  async (status) => {
    const { context, lease } = await setup();
    const noFetch: typeof fetch = async () => {
      throw new Error('unexpected uploads request');
    };
    const client = new YoutubeClient('fixture-key', 3, noFetch);
    await expect(
      executeDiscoveryChunk(
        env.DB,
        context,
        await lease(),
        client,
        now,
        'DISCOVER',
        () => now,
        5,
        async () =>
          new Response('invalid XML', {
            status,
            headers: { 'Retry-After': '120' },
          }),
      ),
    ).rejects.toThrow();
    expect(client.usage.requests).toBe(0);
    expect(
      await env.DB.prepare('SELECT pages_committed FROM discovery_scans').first(
        'pages_committed',
      ),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM change_log WHERE event_type LIKE 'RSS_FALLBACK%'",
      ).first('n'),
    ).toBe(0);
    await refreshMonitoringProgress(env.DB, now);
    expect(
      await env.DB.prepare(
        'SELECT state,completed FROM monitoring_cycles',
      ).first(),
    ).toEqual({ state: 'RUNNING', completed: 0 });
  },
);
it('unknown publication in a NEW_ONLY fallback fails closed instead of importing a potentially historical video', async () => {
  const { context, lease } = await setup(),
    observed: string[] = [];
  await expect(
    executeDiscoveryChunk(
      env.DB,
      context,
      await lease(),
      new YoutubeClient(
        'fixture-key',
        3,
        uploads([{ id: 'unknownxxxx', published: null }], observed),
      ),
      now,
      'DISCOVER',
      () => now,
      5,
      async () => new Response(null, { status: 404 }),
    ),
  ).rejects.toThrow('PARSER');
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM items').first('n')).toBe(
    0,
  );
  expect(
    await env.DB.prepare('SELECT pages_committed FROM discovery_scans').first(
      'pages_committed',
    ),
  ).toBe(0);
});
