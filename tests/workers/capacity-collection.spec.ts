import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import {
  resetCore,
  fixtureOwner,
  fixtureNow,
  fixtureSecret,
} from './core-fixture.js';
import { CapacityCollection } from '../../packages/core/src/projections/capacity-collection.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { randomToken, sha256 } from '../../packages/core/src/auth/crypto.js';
beforeEach(resetCore);
it('collects all-film metadata in bounded owner snapshots without classifying by success or leaking text', async () => {
  const owner = await fixtureOwner();
  const source = (await new SourceRepository(env.DB, owner).upsert(
    {
      namespace: 'youtube',
      external_id: 'UC' + 'a'.repeat(22),
      uploads_playlist_id: 'UU' + 'a'.repeat(22),
      canonical_locator: 'https://www.youtube.com/channel/UC' + 'a'.repeat(22),
      title: 'Source',
      handle: '@source',
    },
    fixtureNow.toISOString(),
  ))!.source_id;
  await env.DB.prepare(
    `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<52) INSERT INTO items(item_id,owner_id,source_id,namespace,external_id,item_type,canonical_url,published_at,publication_provenance,discovered_at,availability) SELECT 'case-'||printf('%03d',x),'a',?,'youtube',printf('%011d',x),'video','https://www.youtube.com/watch?v='||printf('%011d',x),NULL,'UNKNOWN',?,'PUBLIC' FROM n`,
  )
    .bind(source, fixtureNow.toISOString())
    .run();
  const before = await env.DB.prepare(
    'SELECT COUNT(*) n FROM change_log',
  ).first();
  const reader = new CapacityCollection(env.DB, owner),
    first = await reader.page(50, fixtureSecret, fixtureNow);
  expect(first.cases).toHaveLength(50);
  expect(first.eligibility_status).toBe('UNCLASSIFIED');
  expect(first.next_cursor).not.toBeNull();
  expect(first.cases[0]).toMatchObject({
    item_id: 'case-001',
    published_at: null,
    job_id: null,
    accepted_complete_at: null,
  });
  for (const row of first.cases)
    expect(Object.keys(row).join(' ')).not.toMatch(
      /metadata_json|payload_json|outcome_json|quote|prompt_text|credential|Authorization/,
    );
  const last = await reader.page(
    50,
    fixtureSecret,
    new Date(fixtureNow.getTime() + 1000),
    first.next_cursor!,
  );
  expect(last.cases).toHaveLength(2);
  expect(last.sampled_at).toBe(first.sampled_at);
  expect(last.next_cursor).toBeNull();
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM change_log').first(),
  ).toEqual(before);
  expect(
    (
      await new CapacityCollection(env.DB, await fixtureOwner('b')).page(
        50,
        fixtureSecret,
        fixtureNow,
      )
    ).cases,
  ).toHaveLength(0);
  await expect(
    new CapacityCollection(env.DB, await fixtureOwner('b')).page(
      50,
      fixtureSecret,
      fixtureNow,
      first.next_cursor!,
    ),
  ).rejects.toThrow('INVALID_CURSOR');
  await env.DB.prepare(
    "UPDATE items SET published_at='2026-10-05T10:00:00.000Z' WHERE item_id='case-052'",
  ).run();
  await expect(
    reader.page(50, fixtureSecret, fixtureNow, first.next_cursor!),
  ).rejects.toThrow('READ_SNAPSHOT_CHANGED');
  await expect(reader.page(51, fixtureSecret, fixtureNow)).rejects.toThrow(
    'INVALID_LIMIT',
  );
});
it('requires an explicitly PROJECT-scoped worker for measurement reads', async () => {
  const secret = randomToken();
  await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      'collector',
      'a',
      await sha256(secret),
      '["ANALYZE"]',
      fixtureNow.toISOString(),
    )
    .run();
  expect(() => new CapacityCollection(env.DB, {} as AccessContext)).toThrow(
    'INVALID_ACCESS_CONTEXT',
  );
  const denied = await AccessContext.worker(env.DB, await sha256(secret));
  expect(() => new CapacityCollection(env.DB, denied)).toThrow('FORBIDDEN');
  await env.DB.prepare(
    'UPDATE worker_identities SET scopes_json=? WHERE worker_id=?',
  )
    .bind('["PROJECT"]', 'collector')
    .run();
  const approved = await AccessContext.worker(env.DB, await sha256(secret));
  expect(
    (
      await new CapacityCollection(env.DB, approved).page(
        50,
        fixtureSecret,
        fixtureNow,
      )
    ).cases,
  ).toHaveLength(0);
});
