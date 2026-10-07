import { expect, it } from 'vitest';
import {
  localDayRange,
  monthDays,
  publicationDate,
  publicationTimestamp,
} from '../../packages/core/src/projections/dates.js';
it('Warsaw publication days preserve DST, leap dates and UTC boundaries', () => {
  expect(localDayRange('2026-03-29')).toMatchObject({
    start: '2026-03-28T23:00:00.000Z',
    end: '2026-03-29T22:00:00.000Z',
  });
  expect(localDayRange('2026-10-25')).toMatchObject({
    start: '2026-10-24T22:00:00.000Z',
    end: '2026-10-25T23:00:00.000Z',
  });
  expect(localDayRange('2026-01-01').start).toBe('2025-12-31T23:00:00.000Z');
  expect(publicationDate('2026-10-05T22:00:00.000Z')).toBe('2026-10-06');
  expect(publicationTimestamp('2026-10-05T22:30:00.000Z')).toBe(
    '2026-10-06 00:30:00 Europe/Warsaw',
  );
  expect(publicationTimestamp('2026-01-01T23:30:00.000Z')).toBe(
    '2026-01-02 00:30:00 Europe/Warsaw',
  );
  expect(publicationTimestamp('2026-10-25T00:30:00.000Z')).toBe(
    '2026-10-25 02:30:00 Europe/Warsaw',
  );
  expect(publicationTimestamp('2026-10-25T01:30:00.000Z')).toBe(
    '2026-10-25 02:30:00 Europe/Warsaw',
  );
  expect(monthDays('2024-02')).toHaveLength(29);
  expect(monthDays('2026-02')).toHaveLength(28);
  for (const date of [
    '2026-02-29',
    '2026-04-31',
    '2026-1-01',
    '2026-13-01',
    '2026-01-00',
    '2026-01-01T00:00:00Z',
  ])
    expect(() => localDayRange(date)).toThrow('INVALID_DATE');
  expect(() => localDayRange('2026-10-05', 'UTC')).toThrow('INVALID_TIMEZONE');
  expect(() => monthDays('2026-1')).toThrow('INVALID_MONTH');
});
