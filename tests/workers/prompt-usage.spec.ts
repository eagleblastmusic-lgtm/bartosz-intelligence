import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { fixtureOwner, fixtureNow, resetCore } from './core-fixture.js';
import {
  PromptUsage,
  promptUseGuard,
} from '../../packages/core/src/registry/usage.js';
import { PromptRegistry } from '../../packages/core/src/registry/store.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import type { Database } from '../../packages/core/src/db/boundary.js';
import bundle from '../../config/registry/master-bundle.json';
beforeEach(resetCore);
it('withdraws new use atomically without rewriting published text or captured snapshots', async () => {
  const owner = await fixtureOwner(),
    registry = new PromptRegistry(env.DB, owner),
    usage = new PromptUsage(env.DB, owner);
  await registry.importBundle(bundle, fixtureNow);
  await registry.activate('ECONOMY_ANALYSIS_V1', 2, 0, fixtureNow);
  const captured = await registry.current();
  const database: Database = env.DB;
  const race: Database = {
    prepare: (sql) => env.DB.prepare(sql),
    batch: async (statements) => {
      await usage.deprecate(
        captured.prompt_id,
        2,
        captured.prompt_hash,
        'Withdraw new use',
        fixtureNow,
      );
      return database.batch(statements);
    },
  };
  const queued = await new JobStore(race, owner).enqueue(
    {
      item_id: null,
      source_id: null,
      task_type: 'ANALYZE',
      input_revision: 'source',
      profile_revision: 'profile',
      prompt_snapshot_id: captured.prompt_hash,
      routing_policy_version: 'test',
      wire_schema_version: 'economy-wire:1.0',
      canonical_schema_version: 'intelligence-canonical:1.2',
      enrichment_version: '1.0',
      explicit_run_nonce: 'nonce',
      arrival_origin_at: fixtureNow.toISOString(),
      origin_kind: 'MANUAL',
      payload: {},
      priority: 20,
      due_at: fixtureNow.toISOString(),
    },
    fixtureNow.toISOString(),
    promptUseGuard(owner.ownerId, captured.prompt_id, 2),
  );
  expect(queued).toBeNull();
  expect(await env.DB.prepare('SELECT count(*) n FROM jobs').first('n')).toBe(
    0,
  );
  expect(await env.DB.prepare('SELECT count(*) n FROM outbox').first('n')).toBe(
    0,
  );
  await expect(registry.current()).rejects.toThrow('PROMPT_DEPRECATED');
  await expect(registry.currentFamily(captured.prompt_id)).rejects.toThrow(
    'PROMPT_DEPRECATED',
  );
  await expect(
    registry.activate(captured.prompt_id, 2, 1, fixtureNow),
  ).rejects.toThrow('PROMPT_DEPRECATED');
  expect(await registry.load(captured.prompt_id, 2, 1)).toEqual(captured);
  const receipt = await usage.status(captured.prompt_id, 2);
  expect(
    await usage.deprecate(
      captured.prompt_id,
      2,
      captured.prompt_hash,
      'Repeat',
      new Date(fixtureNow.getTime() + 1000),
    ),
  ).toEqual(receipt);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM audit_events WHERE event_type='PROMPT_DEPRECATED'",
    ).first('n'),
  ).toBe(1);
  const other = new PromptUsage(env.DB, await fixtureOwner('b'));
  expect(await other.status(captured.prompt_id, 2)).toBeNull();
  await expect(
    other.deprecate(
      captured.prompt_id,
      2,
      captured.prompt_hash,
      'Foreign',
      fixtureNow,
    ),
  ).rejects.toThrow('NOT_FOUND');
  await expect(
    env.DB.prepare('DELETE FROM config_versions WHERE config_id=?')
      .bind('prompt-disallowed-' + captured.prompt_id + '-2')
      .run(),
  ).rejects.toThrow('IMMUTABLE_CONFIG');
});
