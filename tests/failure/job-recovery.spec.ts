import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import {
  resetCore,
  fixtureOwner,
  fixtureNow,
} from '../workers/core-fixture.js';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import { RunRepository } from '../../packages/core/src/jobs/acceptance.js';
import {
  dispatchOutbox,
  sweep,
  signalDisposition,
} from '../../packages/core/src/jobs/recovery.js';
import { sha256 } from '../../packages/core/src/auth/crypto.js';
beforeEach(resetCore);
it('recovers lost transport after 26 hours, fences a crashed candidate and admits one of two executors', async () => {
  const owner = await fixtureOwner();
  const job = (await new JobStore(env.DB, owner).enqueue(
    {
      item_id: null,
      source_id: null,
      task_type: 'FETCH_TRANSCRIPT',
      input_revision: 'isolated-drill',
      profile_revision: 'local',
      routing_policy_version: 'local-primary-1',
      prompt_snapshot_id: null,
      wire_schema_version: null,
      canonical_schema_version: null,
      enrichment_version: null,
      explicit_run_nonce: '',
      arrival_origin_at: fixtureNow.toISOString(),
      origin_kind: 'BACKFILL',
      payload: {},
      priority: 20,
      due_at: fixtureNow.toISOString(),
    },
    fixtureNow.toISOString(),
  ))!;
  const contexts: AccessContext[] = [];
  for (const id of ['first', 'second']) {
    const credential = await sha256('isolated-drill-' + id);
    await env.DB.prepare('INSERT INTO worker_identities VALUES(?,?,?,?,?,NULL)')
      .bind(
        id,
        'a',
        credential,
        '["FETCH_TRANSCRIPT"]',
        fixtureNow.toISOString(),
      )
      .run();
    contexts.push(await AccessContext.worker(env.DB, credential));
  }
  const stores = contexts.map((context) => new JobStore(env.DB, context));
  const crashed = (await stores[0]!.lease(
    job.job_id,
    'FETCH_TRANSCRIPT',
    fixtureNow,
    'local',
  ))!;
  await stores[0]!.start(crashed, 'FETCH_TRANSCRIPT', fixtureNow);
  const originalRun = new RunRepository(env.DB, contexts[0]!);
  await originalRun.prepare(
    'crashed-candidate',
    job.job_id,
    fixtureNow.toISOString(),
  );
  // This isolated Core drill uses a synthetic result; it does not qualify a transcript provider.
  const outcome = { version: 'isolated-recovery-drill:1' };
  const hash = await sha256(JSON.stringify(outcome));
  await dispatchOutbox(env.DB, async () => {}, fixtureNow);
  const later = new Date(fixtureNow.getTime() + 26 * 60 * 60 * 1000);
  expect((await sweep(env.DB, later, () => true)).expired).toBe(1);
  const leases = await Promise.all(
    stores.map((store) =>
      store.lease(job.job_id, 'FETCH_TRANSCRIPT', later, 'local'),
    ),
  );
  expect(leases.filter(Boolean)).toHaveLength(1);
  const winner = leases.findIndex(Boolean),
    token = leases[winner]!;
  expect(token.fencing_token).toBe(crashed.fencing_token + 1);
  await stores[winner]!.start(token, 'FETCH_TRANSCRIPT', later);
  await expect(
    originalRun.complete(
      crashed,
      'FETCH_TRANSCRIPT',
      'crashed-candidate',
      hash,
      outcome,
      null,
      later,
    ),
  ).rejects.toThrow('STALE_FENCE');
  const runs = new RunRepository(env.DB, contexts[winner]!);
  await runs.prepare('recovered-candidate', job.job_id, later.toISOString());
  expect(
    (
      await runs.complete(
        token,
        'FETCH_TRANSCRIPT',
        'recovered-candidate',
        hash,
        outcome,
        null,
        later,
      )
    ).accepted,
  ).toBe(true);
  expect(
    (
      await runs.complete(
        token,
        'FETCH_TRANSCRIPT',
        'recovered-candidate',
        hash,
        outcome,
        null,
        later,
      )
    ).duplicate,
  ).toBe(true);
  const recovered = (await stores[winner]!.get(job.job_id))!;
  expect(recovered.state).toBe('SUCCEEDED');
  expect(recovered.arrival_origin_at).toBe(job.arrival_origin_at);
  expect(recovered.origin_kind).toBe(job.origin_kind);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM analysis_runs WHERE state='ACCEPTED'",
    ).first('n'),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT state FROM analysis_runs WHERE run_id='crashed-candidate'",
    ).first('state'),
  ).toBe('CANDIDATE');
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM jobs WHERE task_type='PROJECT'",
    ).first('n'),
  ).toBe(1);
  expect(
    await signalDisposition(env.DB, {
      job_id: job.job_id,
      task_type: 'FETCH_TRANSCRIPT',
      fencing_hint: crashed.fencing_token,
    }),
  ).toBe('ACK');
});
