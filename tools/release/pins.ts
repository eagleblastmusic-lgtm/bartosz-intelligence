import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { verifyMigrations, type Migration } from '../db/migrations.js';
export function candidatePins() {
  const selection = [
    'apps',
    'packages',
    'tools',
    'tests',
    'config',
    'db',
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig*.json',
    'vitest.config.ts',
    'playwright.config.ts',
  ];
  if (
    execFileSync('git', ['status', '--porcelain', '--', ...selection], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim()
  )
    throw new Error('CANDIDATE_NOT_CLEAN');
  const ledger = JSON.parse(
    readFileSync('db/migration-ledger.json', 'utf8'),
  ) as { migrations: Migration[] };
  const sql = Object.fromEntries(
    readdirSync('db/migrations')
      .filter((name) => name.endsWith('.sql'))
      .map((name) => [name, readFileSync('db/migrations/' + name, 'utf8')]),
  );
  verifyMigrations(sql, ledger.migrations);
  const paths = execFileSync('git', ['ls-files', '-z', '--', ...selection], {
    encoding: 'utf8',
    windowsHide: true,
  })
    .split('\0')
    .filter(Boolean)
    .sort();
  const hash = createHash('sha256');
  let bytes = 0;
  for (const path of paths) {
    const size = statSync(path).size;
    bytes += size;
    if (size > 8 * 1024 * 1024 || bytes > 64 * 1024 * 1024)
      throw new Error('CANDIDATE_INPUT_TOO_LARGE');
    hash.update(
      JSON.stringify([
        path,
        createHash('sha256').update(readFileSync(path)).digest('hex'),
      ]) + '\n',
    );
  }
  if (!paths.length) throw new Error('CANDIDATE_FILES_REQUIRED');
  return {
    candidate_sha256: hash.digest('hex'),
    migration_set_sha256: createHash('sha256')
      .update(JSON.stringify(ledger.migrations))
      .digest('hex'),
    migration_count: ledger.migrations.length,
    file_count: paths.length,
  };
}
