import { it, expect } from 'vitest';
import {
  canTransition,
  retryDisposition,
  fairJobOrder,
  jobDedup,
} from '../../packages/core/src/jobs/policy.js';
import type { JobInput } from '../../packages/contracts/src/jobs.js';
const now = new Date('2026-10-05T00:00:00Z');
it('canonical transitions and bounded jitter respect quota/auth and terminal success', () => {
  expect(canTransition('SUCCEEDED', 'PENDING')).toBe(false);
  expect(canTransition('RUNNING', 'RETRY_WAIT')).toBe(true);
  expect(canTransition('PENDING', 'SUCCEEDED')).toBe(false);
  expect(retryDisposition('TRANSIENT', 2, now, () => 0.5)).toEqual({
    state: 'RETRY_WAIT',
    due_at: '2026-10-05T00:02:30.000Z',
    reason: 'TRANSIENT',
  });
  expect(retryDisposition('TRANSIENT', 5, now).state).toBe('DEFERRED');
  expect(retryDisposition('AUTH', 1, now).state).toBe('BLOCKED');
  expect(
    retryDisposition('QUOTA', 1, now, Math.random, '2026-10-06T00:00:00Z')
      .due_at,
  ).toBe('2026-10-06T00:00:00Z');
  expect(() => retryDisposition('QUOTA', 1, now)).toThrow('RESET_REQUIRED');
});
it('fairness reserves available slots for backfill without evicting integrity', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    job_id: `job-${i}`,
    origin_kind: i < 10 ? 'NEW' : 'BACKFILL',
    priority: i < 10 ? 80 : 20,
    arrival_origin_at: now.toISOString(),
    task_type: 'ANALYZE',
  }));
  const selected = fairJobOrder(rows, 5, now);
  expect(selected.filter((r) => r.origin_kind === 'BACKFILL')).toHaveLength(1);
  expect(
    fairJobOrder([{ ...rows[0]!, task_type: 'RECONCILE' }, ...rows], 1, now)[0]!
      .task_type,
  ).toBe('RECONCILE');
});
it('dedup ignores retry clock but explicit nonce and bundle revisions create distinct jobs', async () => {
  const input: JobInput = {
    item_id: 'i',
    source_id: 's',
    task_type: 'ANALYZE',
    input_revision: 'r',
    profile_revision: 'p',
    prompt_snapshot_id: 'prompt',
    routing_policy_version: 'route',
    wire_schema_version: 'wire',
    canonical_schema_version: 'canonical',
    enrichment_version: 'mapper',
    explicit_run_nonce: '',
    arrival_origin_at: now.toISOString(),
    origin_kind: 'NEW',
    payload: {},
    priority: 1,
    due_at: now.toISOString(),
  };
  expect(await jobDedup('owner', input)).toBe(
    await jobDedup('owner', { ...input, due_at: 'later' }),
  );
  expect(await jobDedup('owner', input)).not.toBe(
    await jobDedup('owner', { ...input, explicit_run_nonce: 'manual-2' }),
  );
  expect(await jobDedup('owner', input)).not.toBe(
    await jobDedup('owner', { ...input, enrichment_version: 'mapper2' }),
  );
});
