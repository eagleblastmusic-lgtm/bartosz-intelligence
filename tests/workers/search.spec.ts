import { env } from 'cloudflare:workers';
import { beforeEach, it, expect } from 'vitest';
import {
  fixtureOwner,
  fixtureNow,
  fixtureSecret,
  resetCore,
} from './core-fixture.js';
import { SearchIndex } from '../../packages/core/src/knowledge/search-index.js';
import { KnowledgeSearch } from '../../packages/core/src/knowledge/search.js';
import { KnowledgeCorrections } from '../../packages/core/src/knowledge/corrections.js';
import { EntityKnowledge } from '../../packages/core/src/knowledge/entities.js';
import { EntityIdentity } from '../../packages/core/src/knowledge/identity.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { EntityTimeline } from '../../packages/core/src/knowledge/entity-timeline.js';
beforeEach(resetCore);
it('pages all authored alias history and keeps its clock separate from source chronology', async () => {
  const owner = await fixtureOwner(),
    entities = new EntityKnowledge(env.DB, owner),
    timeline = new EntityTimeline(env.DB, owner);
  await env.DB.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?)')
    .bind(
      'a',
      'history',
      'History',
      'TOOL',
      'UNRESOLVED_LITERAL',
      fixtureNow.toISOString(),
    )
    .run();
  for (let revision = 0; revision < 53; revision++)
    await entities.decide(
      {
        entity_id: 'history',
        literal: 'Name ' + revision,
        action: 'APPROVE',
        reason: 'Owner reviewed ' + revision,
        language: null,
        expected_revision: revision,
        decision_id: crypto.randomUUID(),
      },
      fixtureNow,
    );
  const first = await timeline.events('history', 50, fixtureSecret);
  expect(first.events).toHaveLength(50);
  expect(first.chronology).toBe('OWNER_ACTION_TIME');
  expect(
    (await timeline.events('history', 50, fixtureSecret, first.next_cursor!))
      .events,
  ).toHaveLength(3);
  await expect(
    new EntityTimeline(env.DB, await fixtureOwner('b')).events(
      'history',
      50,
      fixtureSecret,
    ),
  ).rejects.toThrow('NOT_FOUND');
  await entities.decide(
    {
      entity_id: 'history',
      literal: 'New name',
      action: 'APPROVE',
      reason: 'New reviewed spelling',
      language: null,
      expected_revision: 53,
      decision_id: crypto.randomUUID(),
    },
    fixtureNow,
  );
  await expect(
    timeline.events('history', 50, fixtureSecret, first.next_cursor!),
  ).rejects.toThrow('READ_SNAPSHOT_CHANGED');
});
it('removes revoked aliases, follows reversible effective identities and fences a revoked index worker', async () => {
  const owner = await fixtureOwner(),
    index = new SearchIndex(env.DB, owner),
    search = new KnowledgeSearch(env.DB, owner),
    entities = new EntityKnowledge(env.DB, owner);
  for (const id of ['left', 'right'])
    await env.DB.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?)')
      .bind('a', id, id, 'TOOL', 'UNRESOLVED_LITERAL', fixtureNow.toISOString())
      .run();
  await entities.decide(
    {
      entity_id: 'left',
      literal: 'Alias Żółć',
      action: 'APPROVE',
      language: null,
      reason: 'Owner verified literal',
      expected_revision: 0,
      decision_id: crypto.randomUUID(),
    },
    fixtureNow,
  );
  const identity = new EntityIdentity(env.DB, owner);
  await identity.confirm(
    await identity.preview({
      action: 'MERGE',
      source_entity_id: 'left',
      target_entity_id: 'right',
      reason: 'Owner resolved same tool',
    }),
    fixtureNow,
  );
  for (let step = 0; step < 20; step++) {
    if (!(await index.step(fixtureNow)).progressed) break;
  }
  expect(
    (
      await search.page(
        'zolc',
        { entity_id: 'right' },
        50,
        fixtureSecret,
        fixtureNow,
      )
    ).documents,
  ).toHaveLength(1);
  await entities.decide(
    {
      entity_id: 'left',
      literal: 'Alias Żółć',
      action: 'REVOKE',
      language: null,
      reason: 'Owner revoked spelling',
      expected_revision: 1,
      decision_id: crypto.randomUUID(),
    },
    fixtureNow,
  );
  // Canonical visibility is enforced even before stale derived bytes are removed.
  expect(
    (await search.page('zolc', {}, 50, fixtureSecret, fixtureNow)).documents,
  ).toHaveLength(0);
  for (let step = 0; step < 20; step++) {
    if (!(await index.step(fixtureNow)).progressed) break;
  }
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM search_documents WHERE kind='ALIAS'",
    ).first('n'),
  ).toBe(0);
  await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      'indexer',
      'a',
      'fixture-indexer-hash',
      '["PROJECT"]',
      fixtureNow.toISOString(),
    )
    .run();
  const worker = await AccessContext.worker(env.DB, 'fixture-indexer-hash');
  const workerIndex = new SearchIndex(env.DB, worker);
  await index.rebuild(fixtureNow);
  const before = await index.metadata();
  await env.DB.prepare(
    "UPDATE worker_identities SET revoked_at=? WHERE worker_id='indexer'",
  )
    .bind(fixtureNow.toISOString())
    .run();
  expect((await workerIndex.step(fixtureNow)).progressed).toBe(false);
  expect(await index.metadata()).toEqual(before);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM jobs').first('n')).toBe(
    0,
  );
});
it('rebuilds derived FTS with Polish literal matches, owner scope, stale notices and original label preservation', async () => {
  const owner = await fixtureOwner(),
    search = new KnowledgeSearch(env.DB, owner),
    index = new SearchIndex(env.DB, owner);
  expect(
    await search.page('zolc', {}, 50, fixtureSecret, fixtureNow),
  ).toMatchObject({ documents: [], freshness: 'UNKNOWN' });
  await env.DB.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?)')
    .bind(
      'a',
      'entity-a',
      'Zażółć gęślą jaźń',
      'TOOL',
      'UNRESOLVED_LITERAL',
      fixtureNow.toISOString(),
    )
    .run();
  await env.DB.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?)')
    .bind(
      'b',
      'entity-b',
      'Zażółć foreign',
      'TOOL',
      'UNRESOLVED_LITERAL',
      fixtureNow.toISOString(),
    )
    .run();
  // Captured by the first rebuild without inventing an extraction timestamp.
  for (let step = 0; step < 10; step++) {
    await index.step(fixtureNow);
    if ((await index.metadata()).freshness === 'FRESH') break;
  }
  const result = await search.page('zazolc', {}, 50, fixtureSecret, fixtureNow);
  expect(result.freshness).toBe('FRESH');
  expect(result.documents).toHaveLength(1);
  expect(result.documents[0]!.text).toBe('Zażółć gęślą jaźń');
  expect(
    (
      await new KnowledgeSearch(env.DB, await fixtureOwner('b')).page(
        'zazolc',
        {},
        50,
        fixtureSecret,
        fixtureNow,
      )
    ).freshness,
  ).toBe('UNKNOWN');
  const corrections = new KnowledgeCorrections(env.DB, owner),
    target = await corrections.read('ENTITY_LABEL', 'entity-a');
  await corrections.apply(
    {
      target_kind: 'ENTITY_LABEL',
      target_id: 'entity-a',
      target_hash: target.target_hash,
      old_value: target.original_value,
      new_value: 'Reviewed spelling',
      action: 'APPLY',
      reason: 'Owner reviewed name',
      expected_revision: 0,
      correction_id: crypto.randomUUID(),
    },
    fixtureNow,
  );
  expect(
    (await search.page('reviewed', {}, 50, fixtureSecret, fixtureNow))
      .freshness,
  ).toBe('STALE');
  for (let step = 0; step < 12; step++) {
    await index.step(fixtureNow);
    if ((await index.metadata()).freshness === 'FRESH') break;
  }
  expect(
    (
      await search.page(
        '"reviewed spelling"',
        {},
        50,
        fixtureSecret,
        fixtureNow,
      )
    ).documents,
  ).toHaveLength(1);
  expect(
    await env.DB.prepare(
      "SELECT label FROM entities WHERE owner_id='a' AND entity_id='entity-a'",
    ).first('label'),
  ).toBe('Zażółć gęślą jaźń');
  expect(
    (
      await search.page(
        'reviewed OR foreign*',
        {},
        50,
        fixtureSecret,
        fixtureNow,
      )
    ).documents,
  ).toHaveLength(0);
});
it('handles interrupted large documents without splitting UTF-16 and pins paginated result generations', async () => {
  const owner = await fixtureOwner(),
    index = new SearchIndex(env.DB, owner),
    search = new KnowledgeSearch(env.DB, owner);
  const large = '😀 zażółć '.repeat(5000) + ' tailword';
  for (let count = 0; count < 55; count++)
    await env.DB.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?)')
      .bind(
        'a',
        'entity-' + String(count).padStart(3, '0'),
        count === 0 ? large : 'Matchword ' + count,
        'TOOL',
        'UNRESOLVED_LITERAL',
        fixtureNow.toISOString(),
      )
      .run();
  await index.step(fixtureNow);
  await index.step(fixtureNow);
  expect((await index.metadata()).freshness).toBe('BUILDING');
  for (let step = 0; step < 100; step++) {
    await index.step(fixtureNow);
    if ((await index.metadata()).freshness === 'FRESH') break;
  }
  expect(
    (await search.page('tailword', {}, 50, fixtureSecret, fixtureNow))
      .documents,
  ).toHaveLength(1);
  const page = await search.page(
    'matchword',
    {},
    50,
    fixtureSecret,
    fixtureNow,
  );
  expect(page.documents).toHaveLength(50);
  expect(page.next_cursor).toBeTruthy();
  const last = await search.page(
    'matchword',
    {},
    50,
    fixtureSecret,
    fixtureNow,
    page.next_cursor!,
  );
  expect(last.documents).toHaveLength(4);
  await expect(
    new KnowledgeSearch(env.DB, await fixtureOwner('b')).page(
      'matchword',
      {},
      50,
      fixtureSecret,
      fixtureNow,
      page.next_cursor!,
    ),
  ).rejects.toThrow('INVALID_CURSOR');
  await expect(
    search.page(
      'tailword',
      {},
      50,
      fixtureSecret,
      fixtureNow,
      page.next_cursor!,
    ),
  ).rejects.toThrow('INVALID_CURSOR');
  await env.DB.prepare(
    "INSERT INTO change_log(owner_id,component,target_id,event_type,created_at) VALUES('a','entities','entity-001','OWNER_CHANGED',?)",
  )
    .bind(fixtureNow.toISOString())
    .run();
  await expect(
    search.page(
      'matchword',
      {},
      50,
      fixtureSecret,
      fixtureNow,
      page.next_cursor!,
    ),
  ).rejects.toThrow('READ_SNAPSHOT_CHANGED');
  const chunks = (
    await env.DB.prepare(
      "SELECT text FROM search_documents WHERE owner_id='a' AND parent_id='ENTITY:entity-000' ORDER BY doc_id",
    ).all<{ text: string }>()
  ).results;
  expect(chunks.every((chunk) => !/[\uD800-\uDFFF]/u.test(chunk.text))).toBe(
    true,
  );
});
