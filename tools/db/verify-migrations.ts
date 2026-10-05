import { readFileSync, readdirSync } from 'node:fs';
import { verifyMigrations } from './migrations.js';
import { DatabaseSync } from 'node:sqlite';
const ledger = JSON.parse(readFileSync('db/migration-ledger.json', 'utf8'));
const files = Object.fromEntries(
  readdirSync('db/migrations')
    .filter((name) => name.endsWith('.sql'))
    .map((name) => [name, readFileSync(`db/migrations/${name}`, 'utf8')]),
);
const verification = verifyMigrations(files, ledger.migrations);
const fresh = new DatabaseSync(':memory:');
const restored = new DatabaseSync(':memory:');
try {
  for (const db of [fresh, restored]) {
    db.exec('PRAGMA foreign_keys=ON');
    for (const name of Object.keys(files).sort()) db.exec(files[name]!);
  }
  if (verification.count) {
    fresh
      .prepare('INSERT INTO owner_users VALUES(?,?,?,?,?)')
      .run(
        'restore-fixture',
        'https://accounts.google.com',
        'fixture-subject',
        1,
        '2026-10-05T00:00:00Z',
      );
    const rows = fresh
      .prepare('SELECT * FROM owner_users ORDER BY owner_id')
      .all();
    for (const row of rows)
      restored
        .prepare('INSERT INTO owner_users VALUES(?,?,?,?,?)')
        .run(
          row.owner_id!,
          row.issuer!,
          row.subject!,
          row.allowlisted!,
          row.created_at!,
        );
    if (
      JSON.stringify(rows) !==
      JSON.stringify(
        restored.prepare('SELECT * FROM owner_users ORDER BY owner_id').all(),
      )
    )
      throw new Error('RESTORE_IDENTITY_MISMATCH');
  }
  for (const db of [fresh, restored]) {
    if (
      db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw new Error('DATABASE_INTEGRITY_FAILED');
  }
  console.log(
    JSON.stringify({
      ...verification,
      fresh_install: 'PASS',
      independent_empty_restore: 'PASS',
      integrity_check: 'PASS',
      foreign_key_check: 'PASS',
    }),
  );
} finally {
  fresh.close();
  restored.close();
}
