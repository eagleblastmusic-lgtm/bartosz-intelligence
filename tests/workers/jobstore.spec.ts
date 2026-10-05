import { env } from 'cloudflare:workers';
import { it, expect, beforeEach } from 'vitest';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';
import { JobStore } from '../../packages/core/src/jobs/store.js';
import type { JobInput } from '../../packages/contracts/src/jobs.js';
beforeEach(resetCore);
export const input: JobInput = {
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
it('concurrent duplicate intake is one job/outbox; manual nonce is separate', async () => {
  const store = new JobStore(env.DB, await fixtureOwner());
  const [first, second] = await Promise.all([
    store.enqueue(input, fixtureNow.toISOString()),
    store.enqueue(input, fixtureNow.toISOString()),
  ]);
  expect(first!.job_id).toBe(second!.job_id);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM outbox').first('n')).toBe(
    1,
  );
  await store.enqueue(
    { ...input, explicit_run_nonce: 'manual-2' },
    fixtureNow.toISOString(),
  );
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM jobs').first('n')).toBe(
    2,
  );
  await expect(
    env.DB.prepare("UPDATE jobs SET state='WAITING'").run(),
  ).rejects.toThrow();
  await expect(
    env.DB.prepare("UPDATE jobs SET state='SUCCEEDED'").run(),
  ).rejects.toThrow('ILLEGAL_JOB_TRANSITION');
  await expect(
    env.DB.prepare("UPDATE jobs SET arrival_origin_at='changed'").run(),
  ).rejects.toThrow('IMMUTABLE_JOB_INPUT');
});
it('source discovery stays PULL and owner cannot replay succeeded/pending or another owner', async () => {
  const store = new JobStore(env.DB, await fixtureOwner());
  const job = (await store.enqueue(
    { ...input, task_type: 'DISCOVER' },
    fixtureNow.toISOString(),
  ))!;
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM outbox').first('n')).toBe(
    0,
  );
  await expect(
    store.replay(job.job_id, fixtureNow.toISOString(), 'request'),
  ).rejects.toThrow('REPLAY_DENIED');
  const other = new JobStore(env.DB, await fixtureOwner('b'));
  expect(await other.get(job.job_id)).toBeNull();
  await expect(
    other.replay(job.job_id, fixtureNow.toISOString(), 'forged'),
  ).rejects.toThrow('REPLAY_DENIED');
});
