import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { fixtureNow, fixtureOwner, resetCore } from './core-fixture.js';
import { PromptRegistry } from '../../packages/core/src/registry/store.js';
import { PromptHistory } from '../../packages/core/src/registry/history.js';
import { PromptUsage } from '../../packages/core/src/registry/usage.js';
import { PromptDrafts } from '../../packages/core/src/registry/draft.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import bundle from '../../config/registry/master-bundle.json';
beforeEach(resetCore);
it('paginates immutable versions without confusing latest drafts with the active pointer', async () => {
  const owner = await fixtureOwner(),
    registry = new PromptRegistry(env.DB, owner),
    history = new PromptHistory(env.DB, owner);
  await registry.importBundle(bundle, fixtureNow);
  await registry.activate('ECONOMY_ANALYSIS_V1', 2, 0, fixtureNow);
  const base = await new PromptDrafts(env.DB, owner).version(
    'ECONOMY_ANALYSIS_V1',
    2,
  );
  await env.DB.batch(
    await Promise.all(
      Array.from({ length: 53 }, async (_, index) => {
        const version = index + 3,
          text = base.prompt_text + '\nSynthetic history version ' + version;
        return env.DB.prepare(
          "INSERT INTO prompt_versions VALUES(?,?,?,?,?,?,'DRAFT',?)",
        ).bind(
          base.prompt_id,
          owner.ownerId,
          version,
          await sha256(text),
          text,
          base.bundle_json,
          fixtureNow.toISOString(),
        );
      }),
    ),
  );
  const first = await history.page(base.prompt_id);
  expect(first.versions).toHaveLength(50);
  expect(first.versions[0]?.version).toBe(55);
  expect(first.next_before).toBe(6);
  const last = await history.page(base.prompt_id, first.next_before);
  expect(last.versions.map((v) => v.version)).toEqual([5, 4, 3, 2]);
  expect(last.next_before).toBeNull();
  expect(await history.active(base.prompt_id)).toMatchObject({
    version: 2,
    generation: 1,
    new_use_allowed: true,
  });
  await new PromptUsage(env.DB, owner).deprecate(
    base.prompt_id,
    2,
    base.prompt_hash,
    'Fixture',
    fixtureNow,
  );
  expect(await history.active(base.prompt_id)).toMatchObject({
    version: 2,
    generation: 1,
    new_use_allowed: false,
  });
  expect(
    (await new PromptDrafts(env.DB, owner).families()).find(
      (f) => f.prompt_id === base.prompt_id,
    ),
  ).toMatchObject({
    active: { version: 2, new_use_allowed: false },
    next_before: 6,
  });
  expect(
    (await history.page(base.prompt_id, 6)).versions.at(-1)?.new_use_allowed,
  ).toBe(false);
  expect(
    (
      await new PromptHistory(env.DB, await fixtureOwner('b')).page(
        base.prompt_id,
      )
    ).versions,
  ).toEqual([]);
  await expect(history.page(base.prompt_id, 0)).rejects.toThrow(
    'INVALID_PROMPT_HISTORY',
  );
});
