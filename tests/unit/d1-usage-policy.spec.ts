import { expect, it } from 'vitest';
import {
  d1DailyLimit,
  nextD1Reset,
} from '../../packages/core/src/db/d1-quota.js';
import { d1UsagePolicy } from '../../tools/deployment/d1-usage-policy.js';
const now = new Date('2026-10-09T20:00:00.000Z');
const sample = {
  state: 'MEASURED_ANALYTICS',
  observed_at: now.toISOString(),
  start_utc: '2026-10-09T00:00:00.000Z',
  account_rows_read: 3999999,
  account_rows_written: 79999,
};
it('classifies explicit daily read/write limits without leaking provider text', () => {
  expect(
    d1DailyLimit(
      new Error(
        "D1_ERROR: Your account has exceeded D1's free tier daily row read limit. private query",
      ),
    ),
  ).toBe('D1_DAILY_READ_LIMIT');
  expect(
    d1DailyLimit(
      new Error(
        "Your account has exceeded D1's free tier daily row write limit.",
      ),
    ),
  ).toBe('D1_DAILY_WRITE_LIMIT');
  for (const error of [
    new Error('D1_ERROR database is busy'),
    new Error('7500'),
    new Error('private SQL'),
    {},
  ])
    expect(d1DailyLimit(error)).toBeNull();
  expect(nextD1Reset(now).toISOString()).toBe('2026-10-10T00:00:00.000Z');
});
it('reserves 20 percent for critical work without claiming exact remaining capacity', () => {
  expect(d1UsagePolicy(sample, now)).toMatchObject({
    noncritical_admitted: true,
    exact_remaining_quota: null,
  });
  expect(
    d1UsagePolicy({ ...sample, account_rows_read: 4000000 }, now),
  ).toMatchObject({
    state: 'RESERVE_CRITICAL_CAPACITY',
    noncritical_admitted: false,
  });
  expect(
    d1UsagePolicy({ ...sample, account_rows_written: 80000 }, now)
      .noncritical_admitted,
  ).toBe(false);
  expect(
    d1UsagePolicy({ ...sample, account_rows_read: 5000000 }, now).state,
  ).toBe('EXHAUSTED');
});
it.each([
  { observed_at: '2026-10-09T19:44:59.000Z' },
  { observed_at: '2026-10-09T20:00:01.000Z' },
  { state: 'UNKNOWN' },
  { account_rows_read: null },
  { start_utc: '2026-10-08T00:00:00.000Z' },
])('fails closed for stale/unknown/wrong-day analytics: %j', (patch) => {
  expect(d1UsagePolicy({ ...sample, ...patch }, now)).toEqual({
    state: 'UNKNOWN',
    noncritical_admitted: false,
    exact_remaining_quota: null,
  });
});
