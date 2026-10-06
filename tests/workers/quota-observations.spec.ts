import { it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { resetCore, fixtureOwner, fixtureNow } from './core-fixture.js';
import {
  QuotaSnapshots,
  type GeminiQuotaObservation,
} from '../../packages/core/src/ai/quota-snapshots.js';
beforeEach(resetCore);
function observation(): GeminiQuotaObservation {
  return {
    version: 'gemini-quota-observation:1',
    project: 'bartosz-intelligence',
    model: 'gemini-3.8-flash',
    tier: 'FREE',
    source: 'GOOGLE_CLOUD_QUOTA_CURRENT',
    sampled_at: fixtureNow.toISOString(),
    buckets: [
      { bucket: 'RPM', limit: 5, used: 0 },
      { bucket: 'RPD', limit: 20, used: 4 },
      { bucket: 'INPUT_TPM', limit: 250000, used: 21 },
    ],
  };
}
it('records actual counters and immutable receipt without refreshing replay or crossing owners', async () => {
  const a = new QuotaSnapshots(env.DB, await fixtureOwner()),
    b = new QuotaSnapshots(env.DB, await fixtureOwner('b'));
  const result = await a.record(observation(), fixtureNow);
  expect(result.snapshots.find((r) => r.bucket === 'RPD')?.remaining).toBe(16);
  expect(result.snapshots.find((r) => r.bucket === 'RPM')?.expires_at).toBe(
    '2026-10-05T17:31:00.000Z',
  );
  expect(result.snapshots.find((r) => r.bucket === 'RPD')?.reset_at).toBe(
    '2026-10-06T07:00:00.000Z',
  );
  expect(
    await a.record(observation(), new Date(fixtureNow.getTime() + 10000)),
  ).toEqual(result);
  const second = await b.record(observation(), fixtureNow);
  expect(second.snapshots[0]!.snapshot_id).not.toBe(
    result.snapshots[0]!.snapshot_id,
  );
  expect(
    (
      await env.DB.prepare('SELECT COUNT(*) n FROM quota_snapshots').first<{
        n: number;
      }>()
    )?.n,
  ).toBe(6);
  expect(
    (
      await env.DB.prepare('SELECT COUNT(*) n FROM config_versions').first<{
        n: number;
      }>()
    )?.n,
  ).toBe(2);
});
it('rejects absent usage, historical peaks, stale observations and malformed buckets without writes', async () => {
  const repo = new QuotaSnapshots(env.DB, await fixtureOwner());
  for (const mutate of [
    (o: GeminiQuotaObservation) =>
      Object.assign(o, { source: 'AI_STUDIO_28_DAY_PEAK' }),
    (o: GeminiQuotaObservation) =>
      Object.assign(o, { sampled_at: '2026-10-05T17:28:59Z' }),
    (o: GeminiQuotaObservation) =>
      Object.assign(o, { sampled_at: '2026-10-05T17:30:01Z' }),
    (o: GeminiQuotaObservation) => Object.assign(o.buckets[0]!, { used: null }),
    (o: GeminiQuotaObservation) => {
      o.buckets[1]!.bucket = 'RPM';
    },
    (o: GeminiQuotaObservation) => {
      o.buckets.pop();
    },
  ]) {
    const o = observation();
    mutate(o);
    await expect(repo.record(o, fixtureNow)).rejects.toThrow(
      'INVALID_QUOTA_OBSERVATION',
    );
  }
  expect(
    (
      await env.DB.prepare('SELECT COUNT(*) n FROM quota_snapshots').first<{
        n: number;
      }>()
    )?.n,
  ).toBe(0);
});
