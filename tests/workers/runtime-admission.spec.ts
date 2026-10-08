import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { fixtureNow, fixtureOwner, resetCore } from './core-fixture.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { pull } from '../../packages/core/src/jobs/recovery.js';
import type { JobInput } from '../../packages/contracts/src/jobs.js';

beforeEach(resetCore);
async function stores() {
  await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      'executor',
      'a',
      await sha256('fixture'),
      '["FETCH_TRANSCRIPT","NORMALIZE","ANALYZE","TRANSLATE"]',
      fixtureNow.toISOString(),
    )
    .run();
  return {
    owner: new JobStore(env.DB, await fixtureOwner()),
    worker: new JobStore(
      env.DB,
      await AccessContext.worker(env.DB, await sha256('fixture')),
    ),
  };
}
function input(
  route: string,
  task: JobInput['task_type'],
  payload: Record<string, unknown> = {},
  nonce = route,
): JobInput {
  return {
    item_id: null,
    source_id: null,
    task_type: task,
    input_revision: 'source',
    profile_revision: 'profile',
    prompt_snapshot_id: null,
    routing_policy_version: route,
    wire_schema_version: null,
    canonical_schema_version: null,
    enrichment_version: null,
    explicit_run_nonce: nonce,
    payload,
    arrival_origin_at: fixtureNow.toISOString(),
    origin_kind: 'MANUAL',
    priority: 20,
    due_at: fixtureNow.toISOString(),
  };
}
it('keeps local caption and correction backlog untouched by cloud leases', async () => {
  const { owner, worker } = await stores();
  for (const [route, task] of [
    ['local-primary-1', 'FETCH_TRANSCRIPT'],
    ['local-source-correction:1', 'NORMALIZE'],
  ] as const) {
    const job = (await owner.enqueue(
      input(route, task),
      fixtureNow.toISOString(),
    ))!;
    expect(
      await worker.lease(job.job_id, task, fixtureNow, 'cloud'),
    ).toBeNull();
    expect(await worker.get(job.job_id)).toMatchObject({
      state: 'PENDING',
      attempt_count: 0,
      fencing_token: 0,
    });
    expect(
      await worker.lease(job.job_id, task, fixtureNow, 'local'),
    ).not.toBeNull();
  }
});
it('enforces the pinned execution location independently of the AI provider', async () => {
  const { owner, worker } = await stores();
  for (const [route, task] of [
    ['pipeline-selector:1', 'ANALYZE'],
    ['optional-selector:1', 'TRANSLATE'],
  ] as const) {
    for (const runtime of ['local', 'cloud'] as const) {
      const job = (await owner.enqueue(
        input(
          route,
          task,
          {
            snapshot: {
              settings: { runtime },
              profile: { provider_id: 'gemini_free' },
            },
          },
          route + runtime,
        ),
        fixtureNow.toISOString(),
      ))!;
      expect(
        await worker.lease(
          job.job_id,
          task,
          fixtureNow,
          runtime === 'local' ? 'cloud' : 'local',
        ),
      ).toBeNull();
      expect(
        await worker.lease(job.job_id, task, fixtureNow, runtime),
      ).not.toBeNull();
    }
    const malformed = (await owner.enqueue(
      input(route, task, {}, route + 'missing-runtime'),
      fixtureNow.toISOString(),
    ))!;
    expect(
      await worker.lease(malformed.job_id, task, fixtureNow, 'local'),
    ).toBeNull();
    expect(
      await worker.lease(malformed.job_id, task, fixtureNow, 'cloud'),
    ).toBeNull();
  }
});
it('filters incompatible runtime before bounded fair pull, avoiding backlog starvation', async () => {
  const { owner, worker } = await stores();
  for (let index = 0; index < 21; index++)
    await owner.enqueue(
      {
        ...input('local-primary-1', 'FETCH_TRANSCRIPT', {}, 'caption-' + index),
        priority: 100,
      },
      fixtureNow.toISOString(),
    );
  const eligible = (await owner.enqueue(
    input('pipeline-selector:1', 'ANALYZE', {
      snapshot: { settings: { runtime: 'cloud' } },
    }),
    fixtureNow.toISOString(),
  ))!;
  const leases = await pull(worker, fixtureNow, 'cloud', 1);
  expect(leases.map((lease) => lease.job.job_id)).toEqual([eligible.job_id]);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE task_type='FETCH_TRANSCRIPT' AND state='PENDING' AND attempt_count=0",
    ).first('n'),
  ).toBe(21);
});
it('filters task capabilities before the candidate limit instead of starving a selected analysis worker', async () => {
  const { owner, worker } = await stores();
  for (let index = 0; index < 21; index++)
    await owner.enqueue(
      {
        ...input('local-primary-1', 'FETCH_TRANSCRIPT', {}, 'caption-' + index),
        priority: 100,
      },
      fixtureNow.toISOString(),
    );
  const eligible = (await owner.enqueue(
    input('pipeline-selector:1', 'ANALYZE', {
      snapshot: { settings: { runtime: 'local' } },
    }),
    fixtureNow.toISOString(),
  ))!;
  expect(
    (await pull(worker, fixtureNow, 'local', 1, ['ANALYZE'])).map(
      (lease) => lease.job.job_id,
    ),
  ).toEqual([eligible.job_id]);
  expect(await pull(worker, fixtureNow, 'local', 1, [])).toEqual([]);
  await expect(
    pull(worker, fixtureNow, 'local', 1, ['BACKUP']),
  ).rejects.toThrow('FORBIDDEN');
});
