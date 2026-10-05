import { env } from 'cloudflare:workers';
import { it, expect, beforeEach } from 'vitest';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import {
  dispatchOutbox,
  sweep,
  signalDisposition,
  pull,
} from '../../packages/core/src/jobs/recovery.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
import { recoverJobs } from '../../apps/api/src/scheduled.js';
import type {
  JobInput,
  QueueSignal,
} from '../../packages/contracts/src/jobs.js';
beforeEach(resetCore);
it('platform recovery dispatches a bounded actual Queue batch', async () => {
  await setup();
  expect(
    (await recoverJobs(env.DB, env.BARTOSZ_QUEUE, fixtureNow)).transport
      .delivered,
  ).toBe(1);
});
const input: JobInput = {
  item_id: null,
  source_id: null,
  task_type: 'FETCH_TRANSCRIPT',
  input_revision: 'r',
  profile_revision: 'economy-1',
  prompt_snapshot_id: null,
  routing_policy_version: 'local-primary-1',
  wire_schema_version: null,
  canonical_schema_version: null,
  enrichment_version: null,
  explicit_run_nonce: '',
  arrival_origin_at: fixtureNow.toISOString(),
  origin_kind: 'BACKFILL',
  payload: {},
  priority: 20,
  due_at: fixtureNow.toISOString(),
};
async function setup() {
  const owner = await fixtureOwner(),
    job = (await new JobStore(env.DB, owner).enqueue(
      input,
      fixtureNow.toISOString(),
    ))!;
  await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
    .bind(
      'local',
      'a',
      await sha256('fixture'),
      '["FETCH_TRANSCRIPT"]',
      fixtureNow.toISOString(),
    )
    .run();
  return {
    job,
    store: new JobStore(
      env.DB,
      await AccessContext.worker(env.DB, await sha256('fixture')),
    ),
  };
}
it('send timeout retains one job, safe resend and durable defer beyond queue retention', async () => {
  const { job, store } = await setup(),
    signals: QueueSignal[] = [];
  const result = await dispatchOutbox(
    env.DB,
    async (signal) => {
      signals.push(signal);
      throw new Error('ambiguous fixture');
    },
    fixtureNow,
  );
  expect(result.delivered).toBe(0);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM jobs').first('n')).toBe(
    1,
  );
  const later = new Date(fixtureNow.getTime() + 60000);
  expect(
    (
      await dispatchOutbox(
        env.DB,
        async (signal) => {
          signals.push(signal);
        },
        later,
      )
    ).delivered,
  ).toBe(1);
  expect(signals[0]).toEqual(signals[1]);
  expect(JSON.stringify(signals)).not.toContain('payload');
  expect(
    await signalDisposition(env.DB, { ...signals[0]!, fencing_hint: 999 }),
  ).toBe('RETRY');
  const lease = (await store.lease(
    job.job_id,
    'FETCH_TRANSCRIPT',
    later,
    'local',
  ))!;
  await store.start(lease, 'FETCH_TRANSCRIPT', later);
  const reset = new Date(later.getTime() + 172800000).toISOString();
  await store.disposition(
    lease,
    'FETCH_TRANSCRIPT',
    'DEFERRED',
    'QUOTA',
    reset,
    later,
  );
  expect(await signalDisposition(env.DB, signals[0]!)).toBe('ACK');
  await sweep(env.DB, new Date(later.getTime() + 86400000), () => true);
  expect((await store.get(job.job_id))!.state).toBe('DEFERRED');
  expect((await store.get(job.job_id))!.arrival_origin_at).toBe(
    input.arrival_origin_at,
  );
});
it('lost queue signal plus worker crash is recovered by durable sweeper and pull', async () => {
  const { job, store } = await setup();
  await dispatchOutbox(env.DB, async () => {}, fixtureNow);
  // Transport is discarded after send/marker; D1 remains authority.
  const leased = await pull(store, fixtureNow, 'local');
  expect(leased).toHaveLength(1);
  await store.start(leased[0]!.token, 'FETCH_TRANSCRIPT', fixtureNow);
  const later = new Date(fixtureNow.getTime() + 900001);
  await sweep(env.DB, later, () => false);
  expect((await store.get(job.job_id))!.state).toBe('RETRY_WAIT');
  await sweep(env.DB, later, () => true);
  const recovered = await pull(store, later, 'local');
  expect(recovered[0]!.token.fencing_token).toBe(2);
  expect(recovered[0]!.job.job_id).toBe(job.job_id);
  await expect(
    store.start(leased[0]!.token, 'FETCH_TRANSCRIPT', later),
  ).rejects.toThrow('STALE_FENCE');
});
it('DB failure after successful send does not fabricate delivery marker', async () => {
  await setup();
  let sent = 0;
  const failing = {
    prepare(sql: string) {
      if (sql.startsWith('UPDATE outbox SET delivered_at='))
        return env.DB.prepare('INSERT INTO fixture_missing VALUES(1)');
      return env.DB.prepare(sql);
    },
    batch: env.DB.batch.bind(env.DB),
  };
  await expect(
    dispatchOutbox(
      failing,
      async () => {
        sent++;
      },
      fixtureNow,
    ),
  ).rejects.toThrow();
  expect(sent).toBe(1);
  expect(
    await env.DB.prepare('SELECT delivered_at FROM outbox').first(
      'delivered_at',
    ),
  ).toBeNull();
  expect(
    (
      await dispatchOutbox(
        env.DB,
        async () => {
          sent++;
        },
        fixtureNow,
      )
    ).delivered,
  ).toBe(1);
  expect(sent).toBe(2);
});
