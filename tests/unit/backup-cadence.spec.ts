import { expect, it } from 'vitest';
import { backupDue } from '../../tools/deployment/backup-cadence.js';
const now = new Date('2026-10-08T20:00:00Z');
const valid = {
  version: 'portable-backup-drill:1',
  recorded_at: '2026-10-08T19:00:00Z',
  captured_at: '2026-10-08T19:00:00Z',
  private_copy_readback: 'PASS',
  independent_sqlite_restore: 'PASS',
  integrity_check: 'PASS',
  foreign_key_check: 'PASS',
};
it('starts before the 24-hour target with room for hourly scheduling and execution', () => {
  expect(backupDue([], now).due).toBe(true);
  expect(
    backupDue([{ ...valid, captured_at: '2026-10-07T22:00:00Z' }], now).due,
  ).toBe(true);
  expect(backupDue([valid], now).due).toBe(false);
  expect(
    backupDue([{ ...valid, captured_at: '2026-10-07T22:00:01Z' }], now).due,
  ).toBe(false);
});
it('failed, incomplete, invalid and future receipts cannot defer a backup', () => {
  expect(
    backupDue(
      [
        { ...valid, integrity_check: 'FAIL' },
        { ...valid, independent_sqlite_restore: undefined },
        { ...valid, recorded_at: 'invalid' },
        { ...valid, recorded_at: '2026-10-09T20:00:00Z' },
      ],
      now,
    ).due,
  ).toBe(true);
});
it('chooses the newest actually verified receipt independently of file ordering', () => {
  expect(
    backupDue([valid, { ...valid, captured_at: '2026-10-06T20:00:00Z' }], now)
      .latest_verified_at,
  ).toBe('2026-10-08T19:00:00.000Z');
  expect(() => backupDue([], new Date('invalid'))).toThrow(
    'INVALID_BACKUP_CLOCK',
  );
});
it('uses capture age rather than completion and conservatively supports old duration receipts', () => {
  expect(
    backupDue([{ ...valid, captured_at: '2026-10-07T21:55:00Z' }], now).due,
  ).toBe(true);
  expect(
    backupDue(
      [{ ...valid, captured_at: undefined, drill_elapsed_ms: 600000 }],
      now,
    ).latest_verified_at,
  ).toBe('2026-10-08T18:50:00.000Z');
  for (const fields of [
    { captured_at: undefined },
    { captured_at: undefined, drill_elapsed_ms: -1 },
    { captured_at: 'invalid' },
    { captured_at: '2026-10-08T19:00:01Z' },
  ])
    expect(backupDue([{ ...valid, ...fields }], now).due).toBe(true);
});
