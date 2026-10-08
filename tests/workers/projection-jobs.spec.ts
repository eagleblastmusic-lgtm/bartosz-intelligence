import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';
import {
  AccessContext,
  type Database,
} from '../../packages/core/src/db/boundary.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { sweep } from '../../packages/core/src/jobs/recovery.js';
import { RunRepository } from '../../packages/core/src/jobs/acceptance.js';
import { SearchIndex } from '../../packages/core/src/knowledge/search-index.js';
import { completeProjectionJob } from '../../packages/core/src/knowledge/projection-jobs.js';
beforeEach(resetCore);
async function fixture() {
  const hash = await sha256('projection-fixture');
  await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      'project-worker',
      'a',
      hash,
      '["FETCH_TRANSCRIPT","PROJECT"]',
      fixtureNow.toISOString(),
    )
    .run();
  const access = await AccessContext.worker(env.DB, hash),
    store = new JobStore(env.DB, access);
  const job = (await new JobStore(env.DB, await fixtureOwner()).enqueue(
    {
      item_id: null,
      source_id: null,
      task_type: 'FETCH_TRANSCRIPT',
      input_revision: 'source',
      profile_revision: 'local',
      prompt_snapshot_id: null,
      routing_policy_version: 'local-primary-1',
      wire_schema_version: null,
      canonical_schema_version: null,
      enrichment_version: null,
      explicit_run_nonce: '',
      arrival_origin_at: fixtureNow.toISOString(),
      origin_kind: 'NEW',
      payload: {},
      priority: 50,
      due_at: fixtureNow.toISOString(),
    },
    fixtureNow.toISOString(),
  ))!;
  const lease = (await store.lease(
    job.job_id,
    'FETCH_TRANSCRIPT',
    fixtureNow,
    'local',
  ))!;
  await store.start(lease, 'FETCH_TRANSCRIPT', fixtureNow);
  const runs = new RunRepository(env.DB, access);
  await runs.prepare('source-run', job.job_id, fixtureNow.toISOString());
  const outcome = { version: 'synthetic-source' };
  await runs.complete(
    lease,
    'FETCH_TRANSCRIPT',
    'source-run',
    await sha256(JSON.stringify(outcome)),
    outcome,
    null,
    fixtureNow,
  );
  return access;
}
it.each(['stable', 'new-content', 'revoked'] as const)(
  'projection completion is fenced, bounded and does not recursively enqueue (%s)',
  async (scenario) => {
    const access = await fixture();
    expect(await completeProjectionJob(env.DB, access, fixtureNow)).toEqual({
      completed: false,
    });
    const index = new SearchIndex(env.DB, access);
    for (let step = 0; step < 30; step++) {
      await index.step(fixtureNow);
      if ((await index.metadata()).freshness === 'FRESH') break;
    }
    expect((await index.metadata()).freshness).toBe('FRESH');
    const before = await env.DB.prepare(
      "SELECT count(*) n FROM jobs WHERE task_type='PROJECT'",
    ).first('n');
    if (scenario === 'new-content')
      await env.DB.prepare(
        "INSERT INTO change_log(owner_id,component,target_id,event_type,created_at) VALUES('a','knowledge','new','UPDATED',?)",
      )
        .bind(fixtureNow.toISOString())
        .run();
    if (scenario === 'revoked')
      await env.DB.prepare(
        "UPDATE worker_identities SET revoked_at=? WHERE worker_id='project-worker'",
      )
        .bind(fixtureNow.toISOString())
        .run();
    const action = completeProjectionJob(env.DB, access, fixtureNow);
    if (scenario === 'revoked')
      await expect(action).rejects.toThrow('UNAUTHENTICATED');
    else expect(await action).toEqual({ completed: scenario === 'stable' });
    expect(
      await env.DB.prepare(
        "SELECT count(*) n FROM jobs WHERE task_type='PROJECT'",
      ).first('n'),
    ).toBe(before);
    expect(
      await env.DB.prepare(
        "SELECT state FROM jobs WHERE task_type='PROJECT'",
      ).first('state'),
    ).toBe(scenario === 'stable' ? 'SUCCEEDED' : 'PENDING');
    if (scenario === 'stable') {
      expect(await completeProjectionJob(env.DB, access, fixtureNow)).toEqual({
        completed: false,
      });
      expect(
        await env.DB.prepare(
          "SELECT finished_at FROM job_attempts a JOIN jobs j USING(owner_id,job_id) WHERE j.task_type='PROJECT'",
        ).first('finished_at'),
      ).toBe(fixtureNow.toISOString());
    }
  },
);
it.each(['new-content', 'revoked'] as const)(
  'rejects projection completion when %s races with the final commit',
  async (scenario) => {
    const access = await fixture();
    const index = new SearchIndex(env.DB, access);
    for (let step = 0; step < 30; step++) {
      await index.step(fixtureNow);
      if ((await index.metadata()).freshness === 'FRESH') break;
    }
    let batches = 0;
    const racing: Database = {
      prepare: (sql) => env.DB.prepare(sql),
      batch: async (statements) => {
        // Metadata read, lease acquisition, then the final fenced commit.
        if (++batches === 3) {
          if (scenario === 'new-content')
            await env.DB.prepare(
              "INSERT INTO change_log(owner_id,component,target_id,event_type,created_at) VALUES('a','knowledge','race','UPDATED',?)",
            )
              .bind(fixtureNow.toISOString())
              .run();
          else
            await env.DB.prepare(
              "UPDATE worker_identities SET revoked_at=? WHERE worker_id='project-worker'",
            )
              .bind(fixtureNow.toISOString())
              .run();
        }
        return env.DB.batch(statements as D1PreparedStatement[]);
      },
    };
    expect(await completeProjectionJob(racing, access, fixtureNow)).toEqual({
      completed: false,
    });
    expect(batches).toBe(3);
    expect(
      await env.DB.prepare(
        "SELECT state FROM jobs WHERE task_type='PROJECT'",
      ).first('state'),
    ).toBe('RUNNING');
    expect(
      await env.DB.prepare(
        "SELECT finished_at FROM job_attempts a JOIN jobs j USING(owner_id,job_id) WHERE j.task_type='PROJECT'",
      ).first('finished_at'),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT count(*) n FROM jobs WHERE task_type='PROJECT'",
      ).first('n'),
    ).toBe(1);
    if (scenario === 'new-content') {
      const later = new Date(fixtureNow.getTime() + 16 * 60 * 1000);
      expect((await sweep(env.DB, later, () => true)).expired).toBe(1);
      for (let step = 0; step < 30; step++) {
        await index.step(later);
        if ((await index.metadata()).freshness === 'FRESH') break;
      }
      expect(await completeProjectionJob(env.DB, access, later)).toEqual({
        completed: true,
      });
      expect(
        await env.DB.prepare(
          "SELECT attempt_count FROM jobs WHERE task_type='PROJECT'",
        ).first('attempt_count'),
      ).toBe(2);
    }
  },
);
