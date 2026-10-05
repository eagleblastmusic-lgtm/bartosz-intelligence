import { env } from 'cloudflare:workers';
import { it, expect, beforeEach } from 'vitest';
import { fixtureOwner, fixtureNow, resetCore } from './core-fixture.js';
import { PromptRegistry } from '../../packages/core/src/registry/store.js';
import bundle from '../../config/registry/master-bundle.json';
beforeEach(resetCore);
it('imports immutable bundle and CAS pointer without changing captured run snapshots', async () => {
  const registry = new PromptRegistry(env.DB, await fixtureOwner());
  await registry.importBundle(bundle, fixtureNow);
  await registry.importBundle(bundle, fixtureNow);
  expect(
    await env.DB.prepare('SELECT COUNT(*) AS n FROM schema_versions').first(
      'n',
    ),
  ).toBe(9);
  expect(
    await env.DB.prepare('SELECT COUNT(*) AS n FROM prompt_versions').first(
      'n',
    ),
  ).toBe(6);
  await expect(
    env.DB.prepare('DELETE FROM schema_versions').run(),
  ).rejects.toThrow('IMMUTABLE_SCHEMA');
  await expect(
    env.DB.prepare('DELETE FROM prompt_versions').run(),
  ).rejects.toThrow('IMMUTABLE_PROMPT');
  await expect(registry.current()).rejects.toThrow('PROMPT_NOT_CONFIGURED');
  expect(await registry.activate('ECONOMY_ANALYSIS_V1', 2, 0, fixtureNow)).toBe(
    1,
  );
  const old = await registry.current();
  expect(old.wire.id).toBe('urn:bartosz:schema:economy-wire:1.0');
  expect(old.canonical.id).toBe(
    'urn:bartosz:schema:intelligence-canonical:1.2',
  );
  await expect(
    registry.activate('ECONOMY_ANALYSIS_V1', 2, 0, fixtureNow),
  ).rejects.toThrow('REGISTRY_GENERATION_CONFLICT');
  await registry.activate('ECONOMY_ANALYSIS_V1', 2, 1, fixtureNow);
  expect((await registry.current()).generation).toBe(2);
  expect(old.generation).toBe(1);
  await expect(registry.load('FULL_ANALYSIS_V1', 2, 0)).rejects.toThrow(
    'PROMPT_NOT_AVAILABLE',
  );
  await expect(
    env.DB.prepare(
      "UPDATE prompt_versions SET prompt_text='changed' WHERE owner_id='a'",
    ).run(),
  ).rejects.toThrow('IMMUTABLE_PROMPT');
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM prompt_versions WHERE owner_id='b'",
    ).first('n'),
  ).toBe(0);
  const other = new PromptRegistry(env.DB, await fixtureOwner('b'));
  await expect(other.current()).rejects.toThrow('PROMPT_NOT_CONFIGURED');
});
