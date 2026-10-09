import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import ledger from '../../db/migration-ledger.json';
import { sqliteAdapter } from '../../tools/db/sqlite-adapter.js';
import {
  assertBackupSchema,
  backupDue,
  backupQuotaReset,
} from '../../tools/deployment/backup-cadence.js';
const now = new Date('2026-10-08T20:00:00Z');
it('refuses capture before the pending index upgrade and admits only the exact applied checksums', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(
      'CREATE TABLE applied_migrations(name TEXT PRIMARY KEY,sha256 TEXT)',
    );
    const insert = sqlite.prepare('INSERT INTO applied_migrations VALUES(?,?)');
    for (const row of ledger.migrations.slice(0, -1))
      insert.run(row.name, row.sha256);
    const db = sqliteAdapter(sqlite);
    await expect(assertBackupSchema(db, ledger.migrations)).rejects.toThrow(
      'BACKUP_SCHEMA_MIGRATION_PENDING',
    );
    const suffix = ledger.migrations.at(-1)!;
    insert.run(suffix.name, suffix.sha256);
    await expect(
      assertBackupSchema(db, ledger.migrations),
    ).resolves.toBeUndefined();
    sqlite
      .prepare('UPDATE applied_migrations SET sha256=? WHERE name=?')
      .run('changed', suffix.name);
    await expect(assertBackupSchema(db, ledger.migrations)).rejects.toThrow(
      'BACKUP_SCHEMA_MIGRATION_PENDING',
    );
  } finally {
    sqlite.close();
  }
});
it('waits only for an actually classified daily quota and resumes at UTC midnight', () => {
  for (const kind of ['READ', 'WRITE']) {
    const failures = [
      {
        reason:
          'CLOUDFLARE_REQUEST_FAILED_400_7500_D1_DAILY_' + kind + '_LIMIT',
        recorded_at: '2026-10-08T19:00:00Z',
      },
    ];
    expect(backupQuotaReset(failures, now)).toBe('2026-10-09T00:00:00.000Z');
    expect(
      backupQuotaReset(failures, new Date('2026-10-09T00:00:00Z')),
    ).toBeNull();
    expect(backupDue([], now).due).toBe(true);
  }
  for (const reason of [
    'CLOUDFLARE_REQUEST_FAILED_400_7500',
    'CLOUDFLARE_TRANSPORT_FAILED',
  ])
    expect(
      backupQuotaReset([{ reason, recorded_at: '2026-10-08T19:00:00Z' }], now),
    ).toBeNull();
  expect(
    backupQuotaReset(
      [
        {
          reason: 'CLOUDFLARE_REQUEST_FAILED_400_7500_D1_DAILY_READ_LIMIT',
          recorded_at: '2026-10-09T19:00:00Z',
        },
      ],
      now,
    ),
  ).toBeNull();
  expect(() => backupQuotaReset([], new Date('invalid'))).toThrow(
    'INVALID_BACKUP_CLOCK',
  );
});
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
