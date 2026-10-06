import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { fixtureOwner, fixtureNow, resetCore } from './core-fixture.js';
import {
  EntityIdentity,
  effectiveEntity,
} from '../../packages/core/src/knowledge/identity.js';
import { EntityKnowledge } from '../../packages/core/src/knowledge/entities.js';
beforeEach(resetCore);
async function seed() {
  for (const id of ['a', 'b', 'c'])
    await env.DB.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?)')
      .bind(
        'a',
        'ent-' + id,
        id,
        'TOOL',
        'UNRESOLVED_LITERAL',
        fixtureNow.toISOString(),
      )
      .run();
  await env.DB.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?)')
    .bind(
      'a',
      'person',
      'Person',
      'PERSON',
      'UNRESOLVED_LITERAL',
      fixtureNow.toISOString(),
    )
    .run();
  return new EntityIdentity(env.DB, await fixtureOwner());
}
const input = (source = 'ent-a', target = 'ent-b') => ({
  action: 'MERGE' as const,
  source_entity_id: source,
  target_entity_id: target,
  reason: 'Owner checked identity against source',
});
async function memberships() {
  return (
    await env.DB.prepare(
      `SELECT e.entity_id,${effectiveEntity('e')} effective_entity_id FROM entities e WHERE e.owner_id='a' AND e.entity_type='TOOL' ORDER BY e.entity_id`,
    ).all()
  ).results;
}
it('merge, undo and split replay memberships without rewriting any raw entity', async () => {
  const identity = await seed();
  const before = await env.DB.prepare(
    'SELECT * FROM entities ORDER BY entity_id',
  ).all();
  const merge = await identity.preview(input());
  expect(merge.expected).toHaveLength(2);
  expect(await identity.confirm(merge, fixtureNow)).toMatchObject({
    duplicate: false,
  });
  expect(await identity.confirm(merge, fixtureNow)).toMatchObject({
    duplicate: true,
  });
  expect(await memberships()).toEqual([
    { entity_id: 'ent-a', effective_entity_id: 'ent-b' },
    { entity_id: 'ent-b', effective_entity_id: 'ent-b' },
    { entity_id: 'ent-c', effective_entity_id: 'ent-c' },
  ]);
  await identity.confirm(
    await identity.undoPreview(merge.event_id, 'Undo incorrect grouping'),
    fixtureNow,
  );
  expect((await memberships())[0]).toMatchObject({
    effective_entity_id: 'ent-a',
  });
  const next = await identity.preview(input());
  await identity.confirm(next, fixtureNow);
  const split = await identity.preview({ ...input(), action: 'SPLIT' });
  await identity.confirm(split, fixtureNow);
  expect((await memberships())[0]).toMatchObject({
    effective_entity_id: 'ent-a',
  });
  expect(
    (await env.DB.prepare('SELECT * FROM entities ORDER BY entity_id').all())
      .results,
  ).toEqual(before.results);
  await expect(
    env.DB.prepare('DELETE FROM entity_identity_events').run(),
  ).rejects.toThrow('IMMUTABLE_IDENTITY_EVENT');
});
it('rejects forged/stale memberships, cross-owner and incompatible cycles and retains dependency ordering', async () => {
  const identity = await seed();
  await expect(identity.preview(input('ent-a', 'person'))).rejects.toThrow(
    'INVALID_IDENTITY_TYPE',
  );
  await expect(
    new EntityIdentity(env.DB, await fixtureOwner('b')).preview(input()),
  ).rejects.toThrow('NOT_FOUND');
  const stale = await identity.preview(input());
  await new EntityKnowledge(env.DB, await fixtureOwner()).decide(
    {
      entity_id: 'ent-a',
      literal: 'Alias',
      action: 'APPROVE',
      language: null,
      reason: 'Confirmed',
      expected_revision: 0,
      decision_id: crypto.randomUUID(),
    },
    fixtureNow,
  );
  await expect(identity.confirm(stale, fixtureNow)).rejects.toThrow(
    'REVISION_CONFLICT',
  );
  const valid = await identity.preview(input());
  await expect(
    identity.confirm(
      {
        ...valid,
        mappings: [{ entity_id: 'ent-a', effective_entity_id: 'ent-c' }],
      },
      fixtureNow,
    ),
  ).rejects.toThrow('REVISION_CONFLICT');
  await identity.confirm(valid, fixtureNow);
  await expect(identity.preview(input('ent-a', 'ent-b'))).rejects.toThrow(
    'INVALID_IDENTITY_CYCLE',
  );
  const chain = await identity.preview(input('ent-b', 'ent-c'));
  await identity.confirm(chain, fixtureNow);
  await expect(
    identity.undoPreview(valid.event_id, 'Undo before later change'),
  ).rejects.toThrow('IDENTITY_UNDO_DEPENDENCY');
  await identity.confirm(
    await identity.undoPreview(chain.event_id, 'Undo outer merge'),
    fixtureNow,
  );
  // The inverse is itself a new event. Older decisions remain historical rather than silently deleted.
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM entity_identity_events').first(
      'n',
    ),
  ).toBe(3);
  expect((await memberships())[0]).toMatchObject({
    effective_entity_id: 'ent-b',
  });
  await identity.confirm(
    await identity.undoPreview(
      valid.event_id,
      'Undo original merge after reversing dependency',
    ),
    fixtureNow,
  );
  expect((await memberships())[0]).toMatchObject({
    effective_entity_id: 'ent-a',
  });
});
