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
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import {
  getScan,
  commitDiscoveryPage,
} from '../../packages/core/src/sources/youtube/discovery.js';
import type { ItemMetadata } from '../../packages/contracts/src/discovery.js';
beforeEach(resetCore);
it('successful unchanged metadata waits 30 days without starving another overdue source or rewriting provenance', async () => {
  const owner = await fixtureOwner();
  const metadata: ItemMetadata = {
    namespace: 'youtube',
    external_id: 'aaaaaaaaaaa',
    canonical_url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    item_type: 'video',
    title: 'Unchanged',
    published_at: '2026-10-01T00:00:00.000Z',
    publication_provenance: 'videos.snippet.publishedAt',
    availability: 'PUBLIC',
    duration_seconds: 60,
  };
  for (const id of ['a', 'b']) {
    const source = (await new SourceRepository(env.DB, owner).upsert(
      {
        namespace: 'youtube',
        external_id: `UC-${id}`,
        canonical_locator: `https://www.youtube.com/channel/UC-${id}`,
        title: id,
        uploads_playlist_id: `UU-${id}`,
        handle: null,
      },
      new Date(fixtureNow.getTime() + (id === 'b' ? 1 : 0)).toISOString(),
    ))!;
    await new ItemRepository(env.DB, owner).upsert(
      source.source_id,
      {
        ...metadata,
        external_id: id.repeat(11),
        canonical_url: `https://www.youtube.com/watch?v=${id.repeat(11)}`,
      },
      new Date(fixtureNow.getTime() + (id === 'b' ? 1 : 0)).toISOString(),
    );
  }
  const now = new Date(fixtureNow.getTime() + 30 * 86400000);
  expect((await scheduleMetadataRefresh(env.DB, now)).scheduled).toBe(1);
  const job = (await env.DB.prepare(
    "SELECT job_id,payload_json FROM jobs WHERE task_type='RECONCILE'",
  ).first<{ job_id: string; payload_json: string }>())!;
  expect(JSON.parse(job.payload_json).ids).toEqual(['aaaaaaaaaaa']);
  await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      'refresh',
      'a',
      await sha256('refresh-fixture'),
      '["RECONCILE"]',
      now.toISOString(),
    )
    .run();
  const context = await AccessContext.worker(
    env.DB,
    await sha256('refresh-fixture'),
  );
  const store = new JobStore(env.DB, context);
  const token = (await store.lease(job.job_id, 'RECONCILE', now, 'local'))!;
  await store.start(token, 'RECONCILE', now);
  await commitDiscoveryPage(
    env.DB,
    context,
    token,
    (await getScan(env.DB, context, job.job_id))!,
    [metadata],
    null,
    now,
    'RECONCILE',
  );
  expect(
    await env.DB.prepare('SELECT state FROM jobs WHERE job_id=?')
      .bind(job.job_id)
      .first('state'),
  ).toBe('SUCCEEDED');
  expect(
    await env.DB.prepare('SELECT coverage FROM discovery_scans WHERE job_id=?')
      .bind(job.job_id)
      .first('coverage'),
  ).toBe('PARTIAL');
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM item_revisions r JOIN items i ON i.owner_id=r.owner_id AND i.item_id=r.item_id WHERE i.external_id='aaaaaaaaaaa'",
    ).first('n'),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT fetched_at FROM item_revisions r JOIN items i ON i.owner_id=r.owner_id AND i.item_id=r.item_id WHERE i.external_id='aaaaaaaaaaa'",
    ).first('fetched_at'),
  ).toBe(fixtureNow.toISOString());
  const next = new Date(now.getTime() + 300000);
  expect((await scheduleMetadataRefresh(env.DB, next)).scheduled).toBe(1);
  const other = (await env.DB.prepare(
    "SELECT payload_json FROM jobs WHERE task_type='RECONCILE' AND state='PENDING'",
  ).first<{ payload_json: string }>())!;
  expect(JSON.parse(other.payload_json).ids).toEqual(['bbbbbbbbbbb']);
  expect((await scheduleMetadataRefresh(env.DB, next)).scheduled).toBe(0);
  expect(
    (
      await scheduleMetadataRefresh(
        env.DB,
        new Date(now.getTime() + 29 * 86400000),
      )
    ).scheduled,
  ).toBe(0);
  expect(
    (
      await scheduleMetadataRefresh(
        env.DB,
        new Date(now.getTime() + 30 * 86400000),
      )
    ).scheduled,
  ).toBe(1);
});
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
