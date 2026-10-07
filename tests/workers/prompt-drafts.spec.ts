import { env } from 'cloudflare:workers';
import { it, expect, beforeEach } from 'vitest';
import { fixtureOwner, fixtureNow, resetCore } from './core-fixture.js';
import { PromptDrafts } from '../../packages/core/src/registry/draft.js';
import { PromptRegistry } from '../../packages/core/src/registry/store.js';
import bundle from '../../config/registry/master-bundle.json';
beforeEach(resetCore);
it('creates immutable compatible drafts with exact bindings while published and captured snapshots stay pinned', async () => {
  const owner = await fixtureOwner(),
    registry = new PromptRegistry(env.DB, owner),
    drafts = new PromptDrafts(env.DB, owner);
  await registry.importBundle(bundle, fixtureNow);
  await registry.activate('ECONOMY_ANALYSIS_V1', 2, 0, fixtureNow);
  const old = await registry.current();
  expect(await drafts.families()).toHaveLength(6);
  const input = {
    prompt_id: old.prompt_id,
    base_version: 2,
    expected_latest_version: 2,
    text: old.text + '\nAdditional owner instruction.',
    reason: 'Improve wording',
  };
  const draft = await drafts.create(input, fixtureNow);
  expect(draft).toMatchObject({
    version: 3,
    status: 'DRAFT',
    required_inputs: expect.any(Array),
  });
  expect((await registry.current()).prompt_hash).toBe(old.prompt_hash);
  await expect(registry.load(old.prompt_id, 3, 1)).rejects.toThrow(
    'PROMPT_NOT_AVAILABLE',
  );
  expect(
    (await drafts.create(input, new Date(fixtureNow.getTime() + 1000))).version,
  ).toBe(3);
  await expect(
    drafts.create({ ...input, text: input.text + 'Changed' }, fixtureNow),
  ).rejects.toThrow('REGISTRY_VERSION_CONFLICT');
  await expect(
    drafts.create(
      {
        ...input,
        expected_latest_version: 3,
        text: input.text + ' {{foreign_binding}}',
      },
      fixtureNow,
    ),
  ).rejects.toThrow('INVALID_PROMPT_INPUTS');
  await expect(
    drafts.create(
      { ...input, expected_latest_version: 3, text: old.text },
      fixtureNow,
    ),
  ).rejects.toThrow('INVALID_UNCHANGED_PROMPT');
  const other = new PromptDrafts(env.DB, await fixtureOwner('b'));
  await expect(other.version(old.prompt_id, 3)).rejects.toThrow('NOT_FOUND');
  expect((await other.families()).every((f) => f.versions.length === 0)).toBe(
    true,
  );
  await expect(
    env.DB.prepare(
      "UPDATE prompt_versions SET prompt_text='mutated' WHERE owner_id='a' AND version=3",
    ).run(),
  ).rejects.toThrow('IMMUTABLE_PROMPT');
  const race = await Promise.allSettled(
    ['A', 'B'].map((suffix) =>
      drafts.create(
        {
          ...input,
          base_version: 3,
          expected_latest_version: 3,
          text: draft.prompt_text + '\n' + suffix,
        },
        fixtureNow,
      ),
    ),
  );
  expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM audit_events WHERE event_type='PROMPT_DRAFT_CREATED'",
    ).first('n'),
  ).toBe(2);
  expect((await drafts.version(old.prompt_id, 3)).prompt_hash).toBe(
    draft.prompt_hash,
  );
  expect((await registry.current()).generation).toBe(1);
  expect(await env.DB.prepare('SELECT count(*) n FROM jobs').first('n')).toBe(
    0,
  );
});
