import { it, expect } from 'vitest';
import { hashSql, verifyMigrations } from '../../tools/db/migrations.js';
const sql = 'CREATE TABLE fixture(id INTEGER PRIMARY KEY);';
const migration = {
  name: '001_fixture.sql',
  sha256: hashSql(sql),
  depends_on: [],
};
it('empty framework reserves 001', () =>
  expect(verifyMigrations({}, [])).toEqual({
    result: 'PASS',
    count: 0,
    next_number: 1,
  }));
it('fresh and upgrade ledgers', () =>
  expect(
    verifyMigrations({ [migration.name]: sql }, [migration], [migration])
      .result,
  ).toBe('PASS'));
it('rejects changed/removed applied migration', () => {
  expect(() =>
    verifyMigrations({ [migration.name]: `${sql} --changed` }, [migration]),
  ).toThrow('MIGRATION_CHECKSUM_INVALID');
  expect(() => verifyMigrations({}, [], [migration])).toThrow(
    'APPLIED_MIGRATION_CHANGED',
  );
});
it('rejects dependency disorder and empty migration', () => {
  expect(() =>
    verifyMigrations({ [migration.name]: sql }, [
      { ...migration, depends_on: ['002_future.sql'] },
    ]),
  ).toThrow('MIGRATION_ORDER_INVALID');
  expect(() => verifyMigrations({ [migration.name]: '' }, [migration])).toThrow(
    'MIGRATION_CHECKSUM_INVALID',
  );
});
