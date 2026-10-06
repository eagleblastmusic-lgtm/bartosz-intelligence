import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { fixtureOwner, fixtureNow, resetCore } from './core-fixture.js';
import {
  EntityKnowledge,
  effectiveAlias,
} from '../../packages/core/src/knowledge/entities.js';
import {
  resolveEntityMention,
  type ApprovedAlias,
} from '../../packages/core/src/ai/enrichment/entities.js';
beforeEach(resetCore);
async function seed() {
  for (const [id, type] of [
    ['tool-a', 'TOOL'],
    ['tool-b', 'TOOL'],
    ['person-a', 'PERSON'],
  ])
    await env.DB.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?)')
      .bind(
        'a',
        id,
        'Claude',
        type,
        'UNRESOLVED_LITERAL',
        fixtureNow.toISOString(),
      )
      .run();
  return new EntityKnowledge(env.DB, await fixtureOwner());
}
const input = (entity_id = 'tool-a', expected_revision = 0) => ({
  entity_id,
  literal: 'Claude',
  reason: 'Owner confirmed literal against source',
  language: null,
  action: 'APPROVE' as const,
  expected_revision,
  decision_id: crypto.randomUUID(),
});
async function aliases() {
  return (
    await env.DB.prepare(
      `SELECT a.owner_id,a.entity_id,a.literal,e.entity_type,(SELECT d.language FROM entity_alias_decisions d WHERE d.owner_id=a.owner_id AND d.alias_id=a.alias_id ORDER BY revision DESC LIMIT 1) language FROM entity_aliases a JOIN entities e ON e.owner_id=a.owner_id AND e.entity_id=a.entity_id WHERE a.owner_id='a' AND ${effectiveAlias}`,
    ).all<ApprovedAlias>()
  ).results;
}
const mention = {
  owner_id: 'a',
  source_artifact_id: 'source',
  mention_index: 0,
  label: 'Claude',
  entity_type: 'TOOL' as const,
};
it('explicit revision-guarded approval/revocation preserves raw identities, owner audit and retry identity', async () => {
  const repository = await seed();
  const first = input();
  expect(await repository.decide(first, fixtureNow)).toEqual({
    revision: 1,
    duplicate: false,
  });
  expect(await repository.decide(first, fixtureNow)).toEqual({
    revision: 1,
    duplicate: true,
  });
  await expect(
    repository.decide({ ...first, reason: 'Different request' }, fixtureNow),
  ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  expect(
    (await resolveEntityMention({ ...mention, aliases: await aliases() }))
      .entity_id,
  ).toBe('tool-a');
  await expect(
    repository.decide(input('tool-a', 0), fixtureNow),
  ).rejects.toThrow('REVISION_CONFLICT');
  const revoke = { ...input('tool-a', 1), action: 'REVOKE' as const };
  expect(await repository.decide(revoke, fixtureNow)).toMatchObject({
    revision: 2,
  });
  expect(
    (await resolveEntityMention({ ...mention, aliases: await aliases() }))
      .resolution,
  ).toBe('UNRESOLVED_LITERAL');
  const detail = await repository.detail('tool-a');
  expect(detail.entity).toMatchObject({
    resolution: 'UNRESOLVED_LITERAL',
    label: 'Claude',
  });
  expect(detail.aliases).toEqual([
    expect.objectContaining({ literal: 'Claude', status: 'REVOKED' }),
  ]);
  expect(detail.history).toEqual([
    expect.objectContaining({
      revision: 2,
      authored_by: 'a',
      action: 'REVOKE',
    }),
    expect.objectContaining({
      revision: 1,
      authored_by: 'a',
      action: 'APPROVE',
    }),
  ]);
  await expect(
    env.DB.prepare("UPDATE entity_alias_decisions SET reason='erased'").run(),
  ).rejects.toThrow('IMMUTABLE_ALIAS_DECISION');
  await expect(
    new EntityKnowledge(env.DB, await fixtureOwner('b')).detail('tool-a'),
  ).rejects.toThrow('NOT_FOUND');
  await expect(
    new EntityKnowledge(env.DB, await fixtureOwner('b')).decide(
      input(),
      fixtureNow,
    ),
  ).rejects.toThrow('NOT_FOUND');
});
it('ambiguous/type/language mappings remain literal and competing revisions cannot both commit', async () => {
  const repository = await seed();
  const settled = await Promise.allSettled([
    repository.decide(input(), fixtureNow),
    repository.decide({ ...input(), literal: 'Another name' }, fixtureNow),
  ]);
  expect(settled.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
  const active = await aliases();
  expect(active).toHaveLength(1);
  await repository.decide(
    { ...input('tool-b'), literal: active[0]!.literal },
    fixtureNow,
  );
  expect(
    (
      await resolveEntityMention({
        ...mention,
        label: active[0]!.literal,
        aliases: await aliases(),
      })
    ).resolution,
  ).toBe('AMBIGUOUS_LITERAL');
  await repository.decide(
    { ...input('person-a'), literal: 'Claudé', language: 'pl' },
    fixtureNow,
  );
  const scoped = {
    ...mention,
    label: 'Claude\u0301',
    entity_type: 'PERSON' as const,
    aliases: await aliases(),
  };
  expect(
    (await resolveEntityMention({ ...scoped, language: 'en' })).resolution,
  ).toBe('UNRESOLVED_LITERAL');
  expect(
    (await resolveEntityMention({ ...scoped, language: 'pl' })).entity_id,
  ).toBe('person-a');
  expect(
    (await resolveEntityMention({ ...scoped, language: null })).resolution,
  ).toBe('UNRESOLVED_LITERAL');
  await expect(
    repository.decide(
      { ...input('person-a', 1), literal: 'absent', action: 'REVOKE' },
      fixtureNow,
    ),
  ).rejects.toThrow('INVALID_ALIAS_REVOCATION');
  expect(
    await env.DB.prepare('SELECT COUNT(*) n FROM entity_alias_decisions').first(
      'n',
    ),
  ).toBe(3);
});
