import { env } from 'cloudflare:workers';
import { it, expect, beforeEach } from 'vitest';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';
import {
  addSource,
  backfillWindow,
} from '../../packages/core/src/sources/youtube/backfill.js';
import type { Database } from '../../packages/core/src/db/boundary.js';
const channel = 'UC' + 'a'.repeat(22);
const identity = {
  namespace: 'youtube' as const,
  external_id: channel,
  canonical_locator: `https://www.youtube.com/channel/${channel}`,
  title: 'Fixture',
  uploads_playlist_id: 'UU' + 'a'.repeat(22),
  handle: '@fixture',
};
beforeEach(resetCore);
it('concurrent same-key source creation is one atomic source/config/job/outbox/scan', async () => {
  const context = await fixtureOwner(),
    window = backfillWindow(fixtureNow);
  const [first, second] = await Promise.all([
    addSource(env.DB, context, identity, 'same-key-1', window, fixtureNow),
    addSource(env.DB, context, identity, 'same-key-1', window, fixtureNow),
  ]);
  expect(first).toEqual(second);
  for (const table of [
    'sources',
    'config_versions',
    'jobs',
    'outbox',
    'discovery_scans',
    'source_requests',
  ])
    expect(
      await env.DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first('n'),
    ).toBe(1);
  expect(
    await addSource(
      env.DB,
      context,
      { ...identity, handle: '@renamed' },
      'other-key',
      window,
      fixtureNow,
    ),
  ).toEqual(first);
  await expect(
    addSource(
      env.DB,
      context,
      identity,
      'same-key-1',
      backfillWindow(fixtureNow, 7),
      fixtureNow,
    ),
  ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  expect(
    (await env.DB.prepare('PRAGMA foreign_key_check').all()).results,
  ).toEqual([]);
});
it('DB error in intent transaction leaves no orphan source or partial request', async () => {
  const failing: Database = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: (statements) =>
      env.DB.batch([
        ...statements.slice(0, 3),
        env.DB.prepare('INSERT INTO missing_fixture VALUES(1)'),
        ...statements.slice(3),
      ] as D1PreparedStatement[]),
  };
  await expect(
    addSource(
      failing,
      await fixtureOwner(),
      identity,
      'same-key-1',
      backfillWindow(fixtureNow),
      fixtureNow,
    ),
  ).rejects.toThrow();
  for (const table of ['sources', 'jobs', 'source_requests'])
    expect(
      await env.DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first('n'),
    ).toBe(0);
});
