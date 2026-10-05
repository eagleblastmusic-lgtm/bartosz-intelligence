import { env } from 'cloudflare:workers';
import { it, expect, beforeEach } from 'vitest';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { RunRepository } from '../../packages/core/src/jobs/acceptance.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { SourceRepository } from '../../packages/core/src/db/sources.js';
import { ItemRepository } from '../../packages/core/src/db/items.js';
import type { JobInput } from '../../packages/contracts/src/jobs.js';
beforeEach(resetCore);
const base: JobInput = {
  item_id: null,
  source_id: null,
  task_type: 'ANALYZE',
  input_revision: 'r',
  profile_revision: 'economy-1',
  prompt_snapshot_id: null,
  routing_policy_version: 'local-primary-1',
  wire_schema_version: null,
  canonical_schema_version: null,
  enrichment_version: null,
  explicit_run_nonce: '',
  arrival_origin_at: fixtureNow.toISOString(),
  origin_kind: 'NEW',
  payload: {},
  priority: 80,
  due_at: fixtureNow.toISOString(),
};
async function worker(id: string) {
  const credential = await sha256(`fixture-${id}`);
  await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(id, 'a', credential, '["ANALYZE"]', fixtureNow.toISOString())
    .run();
  return AccessContext.worker(env.DB, credential);
}
it('two concurrent actual D1 lease calls have one winner and monotonic re-lease fence', async () => {
  const owner = await fixtureOwner(),
    job = (await new JobStore(env.DB, owner).enqueue(
      base,
      fixtureNow.toISOString(),
    ))!;
  const a = new JobStore(env.DB, await worker('a')),
    b = new JobStore(env.DB, await worker('b'));
  const leases = await Promise.all([
    a.lease(job.job_id, 'ANALYZE', fixtureNow, 'local'),
    b.lease(job.job_id, 'ANALYZE', fixtureNow, 'local'),
  ]);
  expect(leases.filter(Boolean)).toHaveLength(1);
  const winner = leases.find(Boolean)!;
  expect(winner.fencing_token).toBe(1);
  const winnerStore = winner.lease_owner === 'a' ? a : b;
  const heartbeatAt = new Date(fixtureNow.getTime() + 60000);
  expect(
    (await winnerStore.heartbeat(winner, 'ANALYZE', heartbeatAt, 'local'))
      .lease_until,
  ).toBe(new Date(fixtureNow.getTime() + 960000).toISOString());
  await env.DB.prepare(
    "UPDATE jobs SET state='RETRY_WAIT',lease_owner=NULL,lease_until=NULL WHERE job_id=?",
  )
    .bind(job.job_id)
    .run();
  await env.DB.prepare("UPDATE jobs SET state='PENDING' WHERE job_id=?")
    .bind(job.job_id)
    .run();
  const newer = (await b.lease(job.job_id, 'ANALYZE', fixtureNow, 'local'))!;
  expect(newer.fencing_token).toBe(2);
  const staleStore = winner.lease_owner === 'a' ? a : b;
  await expect(staleStore.start(winner, 'ANALYZE', fixtureNow)).rejects.toThrow(
    'STALE_FENCE',
  );
});
it('zero-row initial permit yields zero accepted writes/outbox even when D1 batch succeeds', async () => {
  const owner = await fixtureOwner(),
    job = (await new JobStore(env.DB, owner).enqueue(
      base,
      fixtureNow.toISOString(),
    ))!;
  const context = await worker('a'),
    store = new JobStore(env.DB, context),
    runs = new RunRepository(env.DB, context);
  const lease = (await store.lease(
    job.job_id,
    'ANALYZE',
    fixtureNow,
    'local',
  ))!;
  await store.start(lease, 'ANALYZE', fixtureNow);
  await runs.prepare('run-1', job.job_id, fixtureNow.toISOString());
  const outboxBefore = await env.DB.prepare(
    'SELECT COUNT(*) n FROM outbox',
  ).first('n');
  await expect(
    runs.complete(
      { ...lease, fencing_token: 0 },
      'ANALYZE',
      'run-1',
      await sha256('{}'),
      {},
      null,
      fixtureNow,
    ),
  ).rejects.toThrow('STALE_FENCE');
  await expect(
    runs.complete(
      lease,
      'ANALYZE',
      'run-1',
      await sha256('{}'),
      {},
      null,
      new Date(fixtureNow.getTime() + 900000),
    ),
  ).rejects.toThrow('STALE_FENCE');
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM analysis_runs WHERE state='ACCEPTED'",
    ).first('n'),
  ).toBe(0);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM outbox').first('n')).toBe(
    outboxBefore,
  );
  expect(
    await env.DB.prepare('SELECT commit_nonce FROM job_attempts').first(
      'commit_nonce',
    ),
  ).toBeNull();
});
it('SQL failure rolls back permit and accepted writes; repeat success is idempotent', async () => {
  const owner = await fixtureOwner(),
    job = (await new JobStore(env.DB, owner).enqueue(
      base,
      fixtureNow.toISOString(),
    ))!;
  const context = await worker('a'),
    store = new JobStore(env.DB, context),
    runs = new RunRepository(env.DB, context);
  const lease = (await store.lease(
    job.job_id,
    'ANALYZE',
    fixtureNow,
    'local',
  ))!;
  await store.start(lease, 'ANALYZE', fixtureNow);
  await runs.prepare('run-1', job.job_id, fixtureNow.toISOString());
  const broken = new RunRepository(
    {
      prepare: env.DB.prepare.bind(env.DB),
      batch: (statements) =>
        env.DB.batch([
          ...statements.slice(0, 4),
          env.DB.prepare('INSERT INTO nonexistent_fixture VALUES(1)'),
          ...statements.slice(4),
        ] as D1PreparedStatement[]),
    },
    context,
  );
  const hash = await sha256('{}');
  await expect(
    broken.complete(lease, 'ANALYZE', 'run-1', hash, {}, null, fixtureNow),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare('SELECT commit_nonce FROM job_attempts').first(
      'commit_nonce',
    ),
  ).toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM analysis_runs WHERE state='ACCEPTED'",
    ).first('n'),
  ).toBe(0);
  expect(
    await runs.complete(lease, 'ANALYZE', 'run-1', hash, {}, null, fixtureNow),
  ).toEqual({ accepted: true, active: false, duplicate: false });
  expect(
    await runs.complete(lease, 'ANALYZE', 'run-1', hash, {}, null, fixtureNow),
  ).toEqual({ accepted: true, active: false, duplicate: true });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM jobs WHERE task_type='PROJECT'",
    ).first('n'),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM outbox WHERE event_key='accepted:run-1'",
    ).first('n'),
  ).toBe(1);
});
it('valid late older run stays history; current requested run alone can update active selection', async () => {
  const owner = await fixtureOwner();
  const source = (await new SourceRepository(env.DB, owner).upsert(
    {
      namespace: 'youtube',
      external_id: 'UC-fixture',
      canonical_locator: 'https://www.youtube.com/channel/fixture',
      title: 'Fixture',
      uploads_playlist_id: 'UU-fixture',
      handle: null,
    },
    fixtureNow.toISOString(),
  ))!;
  const item = (await new ItemRepository(env.DB, owner).upsert(
    source.source_id,
    {
      namespace: 'youtube',
      external_id: 'video-fixture',
      canonical_url: 'https://www.youtube.com/watch?v=fixture',
      item_type: 'video',
      title: 'Fixture',
      published_at: null,
      publication_provenance: 'UNKNOWN',
      availability: 'PUBLIC',
      duration_seconds: null,
    },
    fixtureNow.toISOString(),
  ))!;
  const context = await worker('a'),
    store = new JobStore(env.DB, context),
    runs = new RunRepository(env.DB, context),
    ownerRuns = new RunRepository(env.DB, owner);
  const jobs = await Promise.all(
    ['old', 'new'].map((nonce) =>
      new JobStore(env.DB, owner).enqueue(
        {
          ...base,
          item_id: item.item_id,
          source_id: source.source_id,
          explicit_run_nonce: nonce,
        },
        fixtureNow.toISOString(),
      ),
    ),
  );
  const leases = [];
  for (let index = 0; index < 2; index++) {
    const lease = (await store.lease(
      jobs[index]!.job_id,
      'ANALYZE',
      fixtureNow,
      'local',
    ))!;
    await store.start(lease, 'ANALYZE', fixtureNow);
    leases.push(lease);
    await runs.prepare(`run-${index}`, lease.job_id, fixtureNow.toISOString());
    await ownerRuns.requestSelection(`run-${index}`, item.item_id);
  }
  expect(
    (
      await runs.complete(
        leases[0]!,
        'ANALYZE',
        'run-0',
        await sha256('{}'),
        {},
        1,
        fixtureNow,
      )
    ).active,
  ).toBe(false);
  expect(
    (
      await runs.complete(
        leases[1]!,
        'ANALYZE',
        'run-1',
        await sha256('{}'),
        {},
        2,
        fixtureNow,
      )
    ).active,
  ).toBe(true);
  expect(
    await env.DB.prepare(
      'SELECT accepted_run_id FROM active_analysis_selections',
    ).first('accepted_run_id'),
  ).toBe('run-1');
});
it('credential rotation invalidates an already authenticated worker context before start/acceptance', async () => {
  const owner = await fixtureOwner(),
    job = (await new JobStore(env.DB, owner).enqueue(
      base,
      fixtureNow.toISOString(),
    ))!;
  const context = await worker('a'),
    store = new JobStore(env.DB, context);
  const lease = (await store.lease(
    job.job_id,
    'ANALYZE',
    fixtureNow,
    'local',
  ))!;
  await env.DB.prepare(
    "UPDATE worker_identities SET credential_hash='rotated' WHERE worker_id='a'",
  ).run();
  await expect(store.start(lease, 'ANALYZE', fixtureNow)).rejects.toThrow(
    'STALE_FENCE',
  );
  expect((await store.get(job.job_id))!.state).toBe('LEASED');
});
