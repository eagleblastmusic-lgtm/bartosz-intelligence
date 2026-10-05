import type { Database } from './boundary.js';
import { sha256 } from '../auth/crypto.js';
export interface RuntimeMigration {
  name: string;
  sha256: string;
  sql: string;
  queries: string[];
  depends_on: string[];
}
// This is a bootstrap-only administrative boundary, never exposed to an executor.
export async function applyMigrations(
  db: Database,
  migrations: RuntimeMigration[],
  now: string,
) {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (
      !/^\d{3}_[a-z0-9_]+\.sql$/.test(migration.name) ||
      seen.has(migration.name) ||
      !migration.queries.length ||
      (await sha256(migration.sql)) !== migration.sha256 ||
      migration.depends_on.some((name) => !seen.has(name)) ||
      (seen.size && migration.name <= [...seen].at(-1)!)
    )
      throw new Error('MIGRATION_INTEGRITY_FAILED');
    seen.add(migration.name);
  }
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS applied_migrations(name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)',
    )
    .run();
  const applied = (
    await db
      .prepare('SELECT name,sha256 FROM applied_migrations ORDER BY name')
      .all<{ name: string; sha256: string }>()
  ).results;
  applied.forEach((row, index) => {
    if (
      migrations[index]?.name !== row.name ||
      migrations[index]?.sha256 !== row.sha256
    )
      throw new Error('APPLIED_MIGRATION_CHANGED');
  });
  for (const migration of migrations.slice(applied.length)) {
    await db.batch([
      ...migration.queries.map((sql) => db.prepare(sql)),
      db
        .prepare(
          'INSERT INTO applied_migrations(name,sha256,applied_at) VALUES(?,?,?)',
        )
        .bind(migration.name, migration.sha256, now),
    ]);
  }
}
