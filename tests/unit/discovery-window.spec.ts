import { it, expect } from 'vitest';
import { discoveryWindow } from '../../packages/core/src/sources/youtube/reconcile.js';
it('48-hour overlap and missed-cron catch-up use old complete watermark rather than current poll time', () => {
  const now = new Date('2026-10-05T00:00:00Z');
  expect(
    discoveryWindow(now, '2026-01-01T00:00:00Z', '2026-10-04T00:00:00Z', 'FULL')
      .window_start,
  ).toBe('2026-10-02T00:00:00.000Z');
  expect(
    discoveryWindow(now, '2026-01-01T00:00:00Z', '2026-09-01T00:00:00Z', 'FULL')
      .window_start,
  ).toBe('2026-08-30T00:00:00.000Z');
  expect(
    discoveryWindow(now, now.toISOString(), null, 'FULL').window_start,
  ).toBe(now.toISOString());
  expect(
    discoveryWindow(now, '2026-01-01T00:00:00Z', null, 'WEEKLY').window_start,
  ).toBe('2026-07-07T00:00:00.000Z');
});
