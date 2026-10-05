import { env } from 'cloudflare:workers';
import { it, expect, beforeEach } from 'vitest';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';
import {
  addSource,
  backfillWindow,
} from '../../packages/core/src/sources/youtube/backfill.js';
import {
  getScan,
  commitDiscoveryPage,
  restartExpiredCursor,
} from '../../packages/core/src/sources/youtube/discovery.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { sweep } from '../../packages/core/src/jobs/recovery.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import type { Database } from '../../packages/core/src/db/boundary.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import type { ItemMetadata } from '../../packages/contracts/src/discovery.js';
import { executeDiscoveryChunk } from '../../packages/core/src/sources/youtube/executor.js';
import { YoutubeClient } from '../../packages/core/src/sources/youtube/client.js';
beforeEach(resetCore);
it('uploads and bulk metadata authority continue after invalid token without trusting playlist insertion order', async () => {
  const { intent, context, lease } = await setup();
  let token = await lease();
  const scan = (await getScan(env.DB, context, intent.job_id))!;
  await commitDiscoveryPage(
    env.DB,
    context,
    token,
    scan,
    [item('known')],
    'invalid',
    fixtureNow,
  );
  token = await lease();
  const observed: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(input as string);
    observed.push(
      url.pathname + ':' + (url.searchParams.get('pageToken') ?? ''),
    );
    if (url.searchParams.get('pageToken') === 'invalid')
      return Response.json(
        { error: { errors: [{ reason: 'invalidPageToken' }] } },
        { status: 400 },
      );
    if (url.pathname.endsWith('playlistItems'))
      return Response.json({
        items: [
          {
            contentDetails: {
              videoId: 'metadataxxx',
              videoPublishedAt: '2026-01-01T00:00:00Z',
            },
          },
        ],
      });
    return Response.json({
      items: [
        {
          id: 'metadataxxx',
          snippet: {
            title: 'Official',
            channelId: channel,
            publishedAt: '2026-10-01T00:00:00Z',
            liveBroadcastContent: 'none',
          },
          contentDetails: { duration: 'PT3M' },
          status: { privacyStatus: 'public' },
        },
      ],
    });
  };
  expect(
    (
      await executeDiscoveryChunk(
        env.DB,
        context,
        token,
        new YoutubeClient('fixture-key', 3, fetcher),
        fixtureNow,
      )
    ).coverage,
  ).toBe('COMPLETE');
  expect(observed).toHaveLength(3);
  expect(
    await env.DB.prepare(
      "SELECT published_at FROM items WHERE external_id='metadataxxx'",
    ).first('published_at'),
  ).toBe('2026-10-01T00:00:00.000Z');
});
const channel = 'UC' + 'a'.repeat(22);
async function setup() {
  const owner = await fixtureOwner();
  const intent = await addSource(
    env.DB,
    owner,
    {
      namespace: 'youtube',
      external_id: channel,
      canonical_locator: `https://www.youtube.com/channel/${channel}`,
      title: 'Fixture',
      uploads_playlist_id: 'UU' + 'a'.repeat(22),
      handle: null,
    },
    'backfill-key',
    backfillWindow(fixtureNow),
    fixtureNow,
  );
  await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      'discovery',
      'a',
      await sha256('fixture'),
      '["DISCOVER"]',
      fixtureNow.toISOString(),
    )
    .run();
  const context = await AccessContext.worker(env.DB, await sha256('fixture'));
  const store = new JobStore(env.DB, context);
  return {
    intent,
    context,
    store,
    async lease() {
      await sweep(env.DB, fixtureNow, () => true);
      const token = (await store.lease(
        intent.job_id,
        'DISCOVER',
        fixtureNow,
        'local',
      ))!;
      await store.start(token, 'DISCOVER', fixtureNow);
      return token;
    },
  };
}
function item(
  id: string,
  pub = '2026-10-01T00:00:00.000Z',
  availability: ItemMetadata['availability'] = 'PUBLIC',
): ItemMetadata {
  return {
    namespace: 'youtube',
    external_id: id.padEnd(11, 'x'),
    canonical_url: `https://www.youtube.com/watch?v=${id.padEnd(11, 'x')}`,
    item_type: id === 'short' ? 'short' : id === 'live' ? 'live' : 'unknown',
    title: id,
    published_at: pub,
    publication_provenance: 'videos.snippet.publishedAt',
    availability,
    duration_seconds: id === 'short' ? 180 : null,
  };
}
it('three pages, known-before-new and nonmonotonic publication retain reference ID/job equality', async () => {
  const { intent, context, lease } = await setup();
  const pages = [
    [item('known'), item('new', '2026-09-06T00:00:00.000Z')],
    [
      item('known'),
      item('short'),
      item('live', '2026-10-04T00:00:00.000Z', 'LIVE'),
    ],
    [item('late', '2026-09-10T00:00:00.000Z')],
  ];
  for (let page = 0; page < 3; page++) {
    const token = await lease(),
      scan = (await getScan(env.DB, context, intent.job_id))!;
    await commitDiscoveryPage(
      env.DB,
      context,
      token,
      scan,
      pages[page]!,
      page === 2 ? null : `page-${page + 2}`,
      fixtureNow,
    );
    expect(
      await env.DB.prepare(
        'SELECT last_complete_window_end FROM sources',
      ).first('last_complete_window_end'),
    ).toBe(page === 2 ? backfillWindow(fixtureNow).window_end : null);
  }
  const items = (
    await env.DB.prepare(
      'SELECT external_id FROM items ORDER BY external_id',
    ).all<{ external_id: string }>()
  ).results.map((row) => row.external_id);
  expect(items).toEqual(
    [...new Set(pages.flat().map((row) => row.external_id))].sort(),
  );
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE task_type='FETCH_TRANSCRIPT'",
    ).first('n'),
  ).toBe(items.length);
  expect(
    await env.DB.prepare('SELECT enumerated_count FROM discovery_scans').first(
      'enumerated_count',
    ),
  ).toBe(items.length);
});
it('page-2 DB crash retains staged page and old watermark; retry commits once; invalid cursor restarts with dedup', async () => {
  const { intent, context, lease } = await setup();
  let token = await lease(),
    scan = (await getScan(env.DB, context, intent.job_id))!;
  await commitDiscoveryPage(
    env.DB,
    context,
    token,
    scan,
    [item('known')],
    'expired-cursor',
    fixtureNow,
  );
  token = await lease();
  scan = (await getScan(env.DB, context, intent.job_id))!;
  const failing: Database = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: (statements) =>
      env.DB.batch([
        ...statements.slice(0, 2),
        env.DB.prepare('INSERT INTO fixture_missing VALUES(1)'),
        ...statements.slice(2),
      ] as D1PreparedStatement[]),
  };
  await expect(
    commitDiscoveryPage(
      failing,
      context,
      token,
      scan,
      [item('second')],
      'page-3',
      fixtureNow,
    ),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare('SELECT last_complete_window_end FROM sources').first(
      'last_complete_window_end',
    ),
  ).toBeNull();
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM items').first('n')).toBe(
    1,
  );
  scan = (await getScan(env.DB, context, intent.job_id))!;
  await commitDiscoveryPage(env.DB, context, token, scan, [], null, fixtureNow);
  token = await lease();
  scan = (await getScan(env.DB, context, intent.job_id))!;
  await restartExpiredCursor(env.DB, context, token, scan, fixtureNow);
  scan = (await getScan(env.DB, context, intent.job_id))!;
  await commitDiscoveryPage(
    env.DB,
    context,
    token,
    scan,
    [item('known'), item('second'), item('third')],
    null,
    fixtureNow,
  );
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM items').first('n')).toBe(
    3,
  );
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE task_type='FETCH_TRANSCRIPT'",
    ).first('n'),
  ).toBe(3);
});
it('50-item page is durable in five-item chunks with <50 statements; stage survives source playlist change', async () => {
  const { intent, context, lease } = await setup();
  const original = Array.from({ length: 50 }, (_, index) => item(`v${index}`));
  let calls = 0;
  const bounded: Database = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements) {
      expect(statements.length).toBeLessThan(50);
      calls++;
      return env.DB.batch(statements as D1PreparedStatement[]);
    },
  };
  for (let chunk = 0; chunk < 10; chunk++) {
    const token = await lease(),
      scan = (await getScan(env.DB, context, intent.job_id))!;
    await commitDiscoveryPage(
      bounded,
      context,
      token,
      scan,
      chunk === 0 ? original : [item('different')],
      null,
      fixtureNow,
    );
    expect(
      await env.DB.prepare(
        'SELECT last_complete_window_end FROM sources',
      ).first('last_complete_window_end'),
    ).toBe(chunk === 9 ? backfillWindow(fixtureNow).window_end : null);
  }
  expect(calls).toBe(10);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM items').first('n')).toBe(
    50,
  );
  expect(
    await env.DB.prepare('SELECT pages_committed FROM discovery_scans').first(
      'pages_committed',
    ),
  ).toBe(1);
});
it('stale fence cannot stage or persist items/jobs/watermark', async () => {
  const { intent, context, lease } = await setup();
  const token = await lease(),
    scan = (await getScan(env.DB, context, intent.job_id))!;
  await expect(
    commitDiscoveryPage(
      env.DB,
      context,
      { ...token, fencing_token: 0 },
      scan,
      [item('forged')],
      null,
      fixtureNow,
    ),
  ).rejects.toThrow('STALE_FENCE');
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM items').first('n')).toBe(
    0,
  );
  expect(
    await env.DB.prepare('SELECT last_complete_window_end FROM sources').first(
      'last_complete_window_end',
    ),
  ).toBeNull();
});
