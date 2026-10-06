import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { fixtureOwner, fixtureNow, resetCore } from './core-fixture.js';
import { KnowledgeCorrections } from '../../packages/core/src/knowledge/corrections.js';
beforeEach(resetCore);
it('rejects restored overlays that do not match the immutable original hash', async () => {
  const owner = await fixtureOwner();
  await env.DB.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?)')
    .bind(
      'a',
      'target',
      'Literal',
      'TOOL',
      'UNRESOLVED_LITERAL',
      fixtureNow.toISOString(),
    )
    .run();
  await env.DB.prepare(
    'INSERT INTO correction_overlays VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  )
    .bind(
      'a',
      crypto.randomUUID(),
      'ENTITY_LABEL',
      'target',
      1,
      '0'.repeat(64),
      'Literal',
      'Literal',
      'Changed',
      'APPLY',
      'Imported correction',
      'a',
      '1'.repeat(64),
      fixtureNow.toISOString(),
    )
    .run();
  await expect(
    new KnowledgeCorrections(env.DB, owner).read('ENTITY_LABEL', 'target'),
  ).rejects.toThrow('CORRECTION_INTEGRITY_INVALID');
});
it('authored label overlays preserve original rows, revisions and reversible history', async () => {
  const owner = await fixtureOwner();
  await env.DB.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?)')
    .bind(
      'a',
      'target',
      'Literal',
      'TOOL',
      'UNRESOLVED_LITERAL',
      fixtureNow.toISOString(),
    )
    .run();
  const corrections = new KnowledgeCorrections(env.DB, owner);
  const before = await corrections.read('ENTITY_LABEL', 'target');
  const input = {
    target_kind: 'ENTITY_LABEL' as const,
    target_id: 'target',
    target_hash: before.target_hash,
    old_value: before.effective_value,
    new_value: 'Owner interpretation',
    expected_revision: 0,
    action: 'APPLY' as const,
    reason: 'Owner reviewed source',
    correction_id: crypto.randomUUID(),
  };
  expect(await corrections.apply(input, fixtureNow)).toEqual({
    revision: 1,
    duplicate: false,
  });
  expect(await corrections.apply(input, fixtureNow)).toEqual({
    revision: 1,
    duplicate: true,
  });
  await expect(
    corrections.apply(
      { ...input, correction_id: crypto.randomUUID() },
      fixtureNow,
    ),
  ).rejects.toThrow('REVISION_CONFLICT');
  const changed = await corrections.read('ENTITY_LABEL', 'target');
  expect(changed).toMatchObject({
    original_value: 'Literal',
    effective_value: 'Owner interpretation',
    revision: 1,
  });
  expect(
    await corrections.apply(
      {
        ...input,
        expected_revision: 1,
        old_value: changed.effective_value,
        new_value: changed.original_value,
        action: 'REVERT',
        correction_id: crypto.randomUUID(),
      },
      fixtureNow,
    ),
  ).toMatchObject({ revision: 2 });
  expect(await corrections.read('ENTITY_LABEL', 'target')).toMatchObject({
    effective_value: 'Literal',
    revision: 2,
    history: [
      expect.objectContaining({ action: 'REVERT' }),
      expect.objectContaining({ action: 'APPLY' }),
    ],
  });
  expect(
    await env.DB.prepare(
      "SELECT label FROM entities WHERE entity_id='target'",
    ).first('label'),
  ).toBe('Literal');
  await expect(
    new KnowledgeCorrections(env.DB, await fixtureOwner('b')).read(
      'ENTITY_LABEL',
      'target',
    ),
  ).rejects.toThrow('NOT_FOUND');
  await expect(
    env.DB.prepare("UPDATE correction_overlays SET new_value='rewrite'").run(),
  ).rejects.toThrow('IMMUTABLE_CORRECTION');
});
