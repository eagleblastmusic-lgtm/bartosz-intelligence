import { env } from 'cloudflare:workers';
import { it, expect, beforeEach } from 'vitest';
import {
  resetCore,
  fixtureOwner,
  fixtureNow,
  fixtureSecret,
} from './core-fixture.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import { ItemRepository } from '../../packages/core/src/db/items.js';
import type {
  ItemMetadata,
  SourceIdentity,
} from '../../packages/contracts/src/discovery.js';
beforeEach(resetCore);
const identity: SourceIdentity = {
  namespace: 'youtube',
  external_id: 'UC_fixture',
  canonical_locator: 'https://www.youtube.com/channel/UC_fixture',
  title: 'Fixture',
  uploads_playlist_id: 'UU_fixture',
  handle: '@fixture',
};
const metadata: ItemMetadata = {
  namespace: 'youtube',
  external_id: 'video-fixture',
  item_type: 'short',
  canonical_url: 'https://www.youtube.com/watch?v=fixture',
  title: 'Original',
  published_at: null,
  publication_provenance: 'UNKNOWN',
  availability: 'PUBLIC',
  duration_seconds: 20,
};
it('source identity survives handle change; duplicate metadata is one immutable revision', async () => {
  const owner = await fixtureOwner(),
    sources = new SourceRepository(env.DB, owner),
    items = new ItemRepository(env.DB, owner);
  const source = (await sources.upsert(identity, fixtureNow.toISOString()))!;
  expect(
    (await sources.upsert(
      { ...identity, handle: '@changed' },
      fixtureNow.toISOString(),
    ))!.source_id,
  ).toBe(source.source_id);
  const item = (await items.upsert(
    source.source_id,
    metadata,
    fixtureNow.toISOString(),
  ))!;
  expect(item.published_at).toBeNull();
  expect(
    (await items.upsert(
      source.source_id,
      { ...metadata },
      fixtureNow.toISOString(),
    ))!.item_id,
  ).toBe(item.item_id);
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM item_revisions').first('n'),
  ).toBe(1);
  const changed = (await items.upsert(
    source.source_id,
    {
      ...metadata,
      title: 'Corrected',
      published_at: '2026-10-03T12:00:00.000Z',
      publication_provenance: 'videos.snippet.publishedAt',
    },
    '2026-10-05T18:00:00.000Z',
  ))!;
  expect(changed.item_id).toBe(item.item_id);
  expect(changed.current_revision_id).not.toBe(item.current_revision_id);
  await items.upsert(
    source.source_id,
    { ...metadata, title: 'stale arrival' },
    fixtureNow.toISOString(),
  );
  expect(
    await env.DB.prepare(
      'SELECT current_revision_id FROM items WHERE item_id=?',
    )
      .bind(item.item_id)
      .first('current_revision_id'),
  ).toBe(changed.current_revision_id);
  await expect(
    env.DB.prepare("UPDATE item_revisions SET metadata_json='{}'").run(),
  ).rejects.toThrow('IMMUTABLE_ITEM_REVISION');
  await sources.disable(
    source.source_id,
    fixtureNow.toISOString(),
    'fixture-correlation',
  );
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM items').first('n')).toBe(
    1,
  );
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM item_revisions').first('n'),
  ).toBe(3);
});
it('cross-owner source/item/revision relationships rejected by actual foreign keys', async () => {
  const ownerA = await fixtureOwner('a'),
    ownerB = await fixtureOwner('b');
  const source = (await new SourceRepository(env.DB, ownerA).upsert(
    identity,
    fixtureNow.toISOString(),
  ))!;
  expect(
    await new SourceRepository(env.DB, ownerB).get(source.source_id),
  ).toBeNull();
  await expect(
    new ItemRepository(env.DB, ownerB).upsert(
      source.source_id,
      metadata,
      fixtureNow.toISOString(),
    ),
  ).rejects.toThrow();
  const item = (await new ItemRepository(env.DB, ownerA).upsert(
    source.source_id,
    metadata,
    fixtureNow.toISOString(),
  ))!;
  await expect(
    env.DB.prepare('INSERT INTO item_revisions VALUES(?,?,?,?,?,?,?)')
      .bind(
        'forged',
        'b',
        item.item_id,
        'forged',
        '{}',
        fixtureNow.toISOString(),
        'PUBLIC',
      )
      .run(),
  ).rejects.toThrow();
  expect(
    (await env.DB.prepare('PRAGMA foreign_key_check').all()).results,
  ).toEqual([]);
});
it('keyset excludes later inserts, binds owner and preserves all initial items without duplicates', async () => {
  const owner = await fixtureOwner(),
    items = new ItemRepository(env.DB, owner);
  const source = (await new SourceRepository(env.DB, owner).upsert(
    identity,
    fixtureNow.toISOString(),
  ))!;
  for (let i = 0; i < 4; i++)
    await items.upsert(
      source.source_id,
      { ...metadata, external_id: `fixture-${i}` },
      fixtureNow.toISOString(),
    );
  const page = await items.list(2, fixtureNow.toISOString(), fixtureSecret);
  await items.upsert(
    source.source_id,
    { ...metadata, external_id: 'later' },
    '2026-10-05T18:00:00.000Z',
  );
  const next = await items.list(
    2,
    '2026-10-05T19:00:00.000Z',
    fixtureSecret,
    page.next_cursor!,
  );
  expect(
    new Set([...page.items, ...next.items].map((row) => row.item_id)).size,
  ).toBe(4);
  expect(next.next_cursor).toBeNull();
  await expect(
    new ItemRepository(env.DB, await fixtureOwner('b')).list(
      2,
      fixtureNow.toISOString(),
      fixtureSecret,
      page.next_cursor!,
    ),
  ).rejects.toThrow('INVALID_CURSOR');
  await expect(
    items.list(51, fixtureNow.toISOString(), fixtureSecret),
  ).rejects.toThrow('INVALID_LIMIT');
  const plan = (
    await env.DB.prepare(
      'EXPLAIN QUERY PLAN SELECT * FROM items WHERE owner_id=? AND published_at>? ORDER BY published_at,item_id LIMIT 50',
    )
      .bind('a', '2026-10-01')
      .all()
  ).results;
  expect(JSON.stringify(plan)).toContain('items_publication');
});
