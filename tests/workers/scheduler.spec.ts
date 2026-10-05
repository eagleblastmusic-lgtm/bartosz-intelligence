import { env } from 'cloudflare:workers';
import { it, expect, beforeEach } from 'vitest';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import { ItemRepository } from '../../packages/core/src/db/items.js';
import {
  scheduleSources,
  repairMissingIntents,
} from '../../packages/core/src/sources/youtube/reconcile.js';
import { scheduleControlPlane } from '../../apps/api/src/scheduled.js';
import { scheduleMetadataRefresh } from '../../packages/core/src/sources/youtube/refresh.js';
beforeEach(resetCore);
it('actual cron control-plane entry schedules a source and retains durable intent', async () => {
  const owner = await fixtureOwner();
  await new SourceRepository(env.DB, owner).upsert(
    {
      namespace: 'youtube',
      external_id: 'UC-fixture',
      canonical_locator: 'https://www.youtube.com/channel/fixture',
      title: 'Fixture',
      uploads_playlist_id: 'UU-fixture',
      handle: null,
    },
    fixtureNow.toISOString(),
  );
  expect(
    (await scheduleControlPlane(env.DB, env.BARTOSZ_QUEUE, fixtureNow)).sources
      .scheduled,
  ).toBe(1);
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM discovery_scans').first('n'),
  ).toBe(1);
});
it('100 due sources are bounded and active scans do not starve remaining due sources', async () => {
  const owner = await fixtureOwner(),
    sources = new SourceRepository(env.DB, owner);
  for (let index = 0; index < 100; index++)
    await sources.upsert(
      {
        namespace: 'youtube',
        external_id: `UC-${index}`,
        canonical_locator: `https://www.youtube.com/channel/UC-${index}`,
        title: 'Fixture',
        uploads_playlist_id: `UU-${index}`,
        handle: null,
      },
      fixtureNow.toISOString(),
    );
  expect(
    (await scheduleSources(env.DB, fixtureNow, 20, () => 0)).examined,
  ).toBe(5);
  expect(
    (await scheduleSources(env.DB, fixtureNow, 20, () => 0)).examined,
  ).toBe(5);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM jobs').first('n')).toBe(
    10,
  );
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM outbox').first('n')).toBe(
    0,
  );
});
it('missing primary task intent is recreated once, preserving publication origin and ownership', async () => {
  const owner = await fixtureOwner(),
    source = (await new SourceRepository(env.DB, owner).upsert(
      {
        namespace: 'youtube',
        external_id: 'UC-fixture',
        canonical_locator: 'https://www.youtube.com/channel/fixture',
        title: 'Fixture',
        uploads_playlist_id: 'UU-fixture',
        handle: null,
      },
      fixtureNow.toISOString(),
    ))!;
  await new ItemRepository(env.DB, owner).upsert(
    source.source_id,
    {
      namespace: 'youtube',
      external_id: 'video-fixture',
      canonical_url: 'https://www.youtube.com/watch?v=fixture',
      item_type: 'video',
      title: 'Fixture',
      published_at: '2026-10-01T00:00:00.000Z',
      publication_provenance: 'videos.snippet.publishedAt',
      availability: 'PUBLIC',
      duration_seconds: null,
    },
    fixtureNow.toISOString(),
  );
  expect((await repairMissingIntents(env.DB, fixtureNow)).repaired).toBe(1);
  expect((await repairMissingIntents(env.DB, fixtureNow)).repaired).toBe(0);
  expect(
    (
      await scheduleMetadataRefresh(
        env.DB,
        new Date(fixtureNow.getTime() + 29 * 86400000),
      )
    ).scheduled,
  ).toBe(0);
  expect(
    (
      await scheduleMetadataRefresh(
        env.DB,
        new Date(fixtureNow.getTime() + 30 * 86400000),
      )
    ).scheduled,
  ).toBe(1);
  expect(
    (
      await scheduleMetadataRefresh(
        env.DB,
        new Date(fixtureNow.getTime() + 30 * 86400000),
      )
    ).scheduled,
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT arrival_origin_at FROM jobs WHERE task_type='FETCH_TRANSCRIPT'",
    ).first('arrival_origin_at'),
  ).toBe('2026-10-01T00:00:00.000Z');
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM outbox').first('n')).toBe(
    1,
  );
});
