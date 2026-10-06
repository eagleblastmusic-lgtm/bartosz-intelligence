import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import bundle from '../../config/registry/master-bundle.json';
import { SemanticProfiles } from '../../packages/core/src/registry/semantic-profiles.js';
import {
  semanticModules,
  type SemanticProfile,
} from '../../packages/core/src/ai/semantic-profile.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { backupTables } from '../../packages/core/src/backup/snapshot.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import { ItemRepository } from '../../packages/core/src/db/items.js';
import { fixtureNow, fixtureOwner, resetCore } from './core-fixture.js';

beforeEach(resetCore);
it('applies explicit pending policy only to unpinned materials and keeps new-only and future assignments bounded', async () => {
  const owner = await fixtureOwner(),
    registry = new SemanticProfiles(env.DB, owner);
  const source = (await new SourceRepository(env.DB, owner).upsert(
    {
      namespace: 'youtube',
      external_id: 'UCfixture',
      canonical_locator: 'https://www.youtube.com/channel/UCfixture',
      title: 'Fixture',
      uploads_playlist_id: 'UUfixture',
      handle: null,
    },
    fixtureNow.toISOString(),
  ))!;
  const earlier = new Date(fixtureNow.getTime() - 60000);
  const item = (await new ItemRepository(env.DB, owner).upsert(
    source.source_id,
    {
      namespace: 'youtube',
      external_id: 'fixture0001',
      canonical_url: 'https://www.youtube.com/watch?v=fixture0001',
      title: 'Fixture',
      item_type: 'video',
      published_at: null,
      publication_provenance: 'UNKNOWN',
      duration_seconds: null,
      availability: 'PUBLIC',
    },
    earlier.toISOString(),
  ))!;
  const economy = {
    ...config,
    mode: 'ECONOMY' as const,
    modules: Object.fromEntries(
      semanticModules.map((key, i) => [key, i < 7]),
    ) as SemanticProfile['modules'],
  };
  await registry.save({ ...input, config: economy }, bundle, fixtureNow);
  const assignment = {
    profile_id: input.profile_id,
    revision: 1,
    source_id: null,
    effective_from: fixtureNow.toISOString(),
    apply_to_pending: false,
    reason: 'New films only',
  };
  await registry.assign(assignment, 0, fixtureNow);
  expect(await registry.forItem(item.item_id, fixtureNow)).toBeNull();
  await registry.assign(
    { ...assignment, apply_to_pending: true, reason: 'Explicit pending films' },
    1,
    fixtureNow,
  );
  expect((await registry.forItem(item.item_id, fixtureNow))?.revision).toBe(1);
  await expect(registry.assign(assignment, 0, fixtureNow)).rejects.toThrow(
    'SEMANTIC_PROFILE_REVISION_CONFLICT',
  );
  await registry.save(
    { ...input, revision: 2, config: economy, name: 'Future scope' },
    bundle,
    fixtureNow,
  );
  await registry.assign(
    {
      ...assignment,
      revision: 2,
      effective_from: new Date(fixtureNow.getTime() + 60000).toISOString(),
      apply_to_pending: true,
    },
    2,
    fixtureNow,
  );
  expect((await registry.forItem(item.item_id, fixtureNow))?.revision).toBe(1);
  expect(
    (
      await registry.forItem(
        item.item_id,
        new Date(fixtureNow.getTime() + 60000),
      )
    )?.revision,
  ).toBe(2);
  expect((await registry.assignments()).assignments).toHaveLength(1);
  const other = new SemanticProfiles(env.DB, await fixtureOwner('b'));
  expect((await other.assignments()).assignments).toEqual([]);
  await expect(
    other.assign({ ...assignment, source_id: source.source_id }, 0, fixtureNow),
  ).rejects.toThrow('NOT_FOUND');
  await registry.save(
    {
      ...input,
      profile_id: 'draft-only',
      config: { ...config, history: true },
    },
    bundle,
    fixtureNow,
  );
  await expect(
    registry.assign({ ...assignment, profile_id: 'draft-only' }, 3, fixtureNow),
  ).rejects.toThrow('CAPABILITY_NOT_AVAILABLE');
});
const config: SemanticProfile = {
  mode: 'CUSTOM',
  modules: Object.fromEntries(
    semanticModules.map((key) => [key, key === 'summary']),
  ) as SemanticProfile['modules'],
  translation: 'NONE',
  history: false,
  second_pass: null,
  validation_pass: null,
};
const input = {
  profile_id: 'monitoring',
  revision: 1,
  name: 'Monitoring',
  config,
  reason: 'Zakres właściciela',
};
it('persists exact schema and v2 prompt with immutable owner-scoped revisions and safe retry', async () => {
  const owner = await fixtureOwner();
  const registry = new SemanticProfiles(env.DB, owner);
  const first = await registry.save(input, bundle, fixtureNow);
  expect(await registry.save(input, bundle, fixtureNow)).toEqual(first);
  expect(await registry.load('monitoring', 1)).toEqual(first);
  expect(first.compiled.prompt.id).toBe('ADVANCED_ANALYSIS_V1');
  expect(first.compiled.prompt.version).toBe(2);
  const schema = await env.DB.prepare(
    'SELECT schema_hash,schema_json FROM schema_versions WHERE schema_id=?',
  )
    .bind(first.compiled.wire.id)
    .first<{ schema_hash: string; schema_json: string }>();
  expect(schema?.schema_hash).toBe(first.compiled.wire.hash);
  expect(JSON.parse(schema!.schema_json)).toEqual(first.compiled.wire.schema);
  await expect(
    registry.save(
      { ...input, config: { ...config, history: true } },
      bundle,
      fixtureNow,
    ),
  ).rejects.toThrow('IMMUTABLE_SEMANTIC_PROFILE_CONFLICT');
  await expect(
    env.DB.prepare(
      "UPDATE semantic_profile_versions SET name='Changed' WHERE owner_id='a'",
    ).run(),
  ).rejects.toThrow('IMMUTABLE_SEMANTIC_PROFILE');
  await expect(
    env.DB.prepare(
      "DELETE FROM semantic_profile_versions WHERE owner_id='a'",
    ).run(),
  ).rejects.toThrow('IMMUTABLE_SEMANTIC_PROFILE');
  const other = new SemanticProfiles(env.DB, await fixtureOwner('b'));
  expect(await other.load('monitoring', 1)).toBeNull();
  expect((await other.list()).profiles).toEqual([]);
  expect(backupTables).toContain('semantic_profile_versions');
});

it('rejects skipped revisions and concurrent edits while preserving a captured snapshot', async () => {
  const registry = new SemanticProfiles(env.DB, await fixtureOwner());
  await expect(
    registry.save({ ...input, revision: 2 }, bundle, fixtureNow),
  ).rejects.toThrow('SEMANTIC_PROFILE_REVISION_CONFLICT');
  const pinned = await registry.save(input, bundle, fixtureNow);
  const edits = await Promise.allSettled([
    registry.save(
      { ...input, revision: 2, config: { ...config, history: true } },
      bundle,
      fixtureNow,
    ),
    registry.save(
      { ...input, revision: 2, config: { ...config, translation: 'FULL' } },
      bundle,
      fixtureNow,
    ),
  ]);
  expect(edits.filter((edit) => edit.status === 'fulfilled')).toHaveLength(1);
  expect(edits.filter((edit) => edit.status === 'rejected')).toHaveLength(1);
  expect(await registry.load('monitoring', 1)).toEqual(pinned);
  expect((await registry.list()).profiles).toHaveLength(2);
  expect(pinned.compiled.config.history).toBe(false);
});

it('enforces worker permissions and backup mutation barrier', async () => {
  const registry = new SemanticProfiles(env.DB, await fixtureOwner());
  await registry.save(input, bundle, fixtureNow);
  for (const [id, scope] of [
    ['analysis', 'ANALYZE'],
    ['caption', 'FETCH_TRANSCRIPT'],
  ] as const) {
    const hash = await sha256(`fixture-${id}-semantic-worker`);
    await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,?)')
      .bind(
        id,
        'a',
        hash,
        JSON.stringify([scope]),
        fixtureNow.toISOString(),
        null,
      )
      .run();
    const worker = new SemanticProfiles(
      env.DB,
      await AccessContext.worker(env.DB, hash),
    );
    await expect(worker.save(input, bundle, fixtureNow)).rejects.toThrow(
      'FORBIDDEN',
    );
    await expect(worker.list()).rejects.toThrow('FORBIDDEN');
    if (scope === 'ANALYZE')
      expect((await worker.load('monitoring', 1))?.compiled.config).toEqual(
        config,
      );
    else
      await expect(worker.load('monitoring', 1)).rejects.toThrow('FORBIDDEN');
  }
  await env.DB.prepare(
    "UPDATE maintenance_state SET barrier_token='fixture-barrier',barrier_until='2099-01-01T00:00:00.000Z'",
  ).run();
  await expect(
    registry.save({ ...input, revision: 2 }, bundle, fixtureNow),
  ).rejects.toThrow('BACKUP_MUTATION_PAUSED');
});
