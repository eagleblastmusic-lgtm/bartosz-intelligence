import { expect, it } from 'vitest';
import { backupDue } from '../../tools/deployment/backup-cadence.js';
const now = new Date('2026-10-08T20:00:00Z');
const valid = {
  version: 'portable-backup-drill:1',
  recorded_at: '2026-10-08T19:00:00Z',
  private_copy_readback: 'PASS',
  independent_sqlite_restore: 'PASS',
  integrity_check: 'PASS',
  foreign_key_check: 'PASS',
};
it('requires a backup with no history or at the 24-hour boundary', () => {
  expect(backupDue([], now).due).toBe(true);
  expect(
    backupDue([{ ...valid, recorded_at: '2026-10-07T20:00:00Z' }], now).due,
  ).toBe(true);
  expect(backupDue([valid], now).due).toBe(false);
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
    backupDue([valid, { ...valid, recorded_at: '2026-10-06T20:00:00Z' }], now)
      .latest_verified_at,
  ).toBe('2026-10-08T19:00:00.000Z');
  expect(() => backupDue([], new Date('invalid'))).toThrow(
    'INVALID_BACKUP_CLOCK',
  );
});
