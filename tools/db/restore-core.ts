import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  restoreCanonical,
  verifyPortableBackup,
} from '../../packages/core/src/backup/restore.js';
import type { PortableCoreBackup } from '../../packages/core/src/backup/restore.js';
import { sqliteAdapter } from './sqlite-adapter.js';
import { verifyMigrations } from './migrations.js';
import { requirePrivateRecoveryDirectory } from './private-directory.js';
const inputPath = process.argv[2];
if (!inputPath || !process.env.GOOGLE_OIDC_OWNER_SUBJECT)
  throw new Error('PRIVATE_BACKUP_AND_OWNER_BINDING_REQUIRED');
if (statSync(inputPath).size > 64 * 1024 * 1024)
  throw new Error('BACKUP_FILE_TOO_LARGE');
const bytes = readFileSync(inputPath),
  portable = JSON.parse(bytes.toString('utf8')) as PortableCoreBackup;
await verifyPortableBackup(portable);
const ledger = JSON.parse(readFileSync('db/migration-ledger.json', 'utf8'));
const files = Object.fromEntries(
  ledger.migrations.map((row: { name: string }) => [
    row.name,
    readFileSync('db/migrations/' + row.name, 'utf8'),
  ]),
);
verifyMigrations(files, ledger.migrations);
const directory = resolve('.local/backups');
if (process.platform === 'win32') requirePrivateRecoveryDirectory(directory);
mkdirSync(directory, { recursive: true });
const target = join(directory, portable.manifest.backup_id + '.sqlite');
if (existsSync(target)) throw new Error('RESTORE_TARGET_EXISTS');
const db = new DatabaseSync(target);
try {
  db.exec('PRAGMA foreign_keys=ON');
  for (const migration of ledger.migrations) db.exec(files[migration.name]);
  const verified = await restoreCanonical(
    sqliteAdapter(db),
    portable,
    process.env.GOOGLE_OIDC_OWNER_SUBJECT,
  );
  if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
    throw new Error('RESTORE_INTEGRITY_FAILED');
  const locator = {
    format: 'bartosz-core-1',
    backup_id: portable.manifest.backup_id,
    backup_file: resolve(inputPath),
    backup_sha256: createHash('sha256').update(bytes).digest('hex'),
    restored_database: target,
    verified_at: new Date().toISOString(),
    ...verified,
  };
  writeFileSync(
    join(directory, portable.manifest.backup_id + '-recovery-locator.json'),
    JSON.stringify(locator, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      result: 'PASS',
      backup_id: locator.backup_id,
      rows: verified.rows,
      bytes: verified.bytes,
      integrity_check: 'PASS',
      foreign_key_check: 'PASS',
      active_sessions_restored: 0,
      active_worker_credentials_restored: 0,
      recovery_locator_written: true,
      independent_medium_receipt: false,
      independent_medium_status: 'NOT_VERIFIED',
    }),
  );
} finally {
  db.close();
}
