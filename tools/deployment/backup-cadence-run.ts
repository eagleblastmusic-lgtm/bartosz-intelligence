import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { backupDue, type BackupReceipt } from './backup-cadence.js';

const args = process.argv.slice(2);
if (args.length !== 1 || !['--check', '--run-if-due'].includes(args[0]!))
  throw new Error('EXPLICIT_BACKUP_CADENCE_MODE_REQUIRED');
const root = resolve('docs/verification/backup');
const receipts: BackupReceipt[] = [];
if (existsSync(root)) {
  const names = readdirSync(root).filter((name) => name.endsWith('.json'));
  if (names.length > 4096) throw new Error('BACKUP_RECEIPT_LIMIT');
  for (const name of names) {
    const path = join(root, name);
    if (statSync(path).size > 65536) continue;
    try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const row = value as BackupReceipt & {
          backup_id?: unknown;
          backup_sha256?: unknown;
        };
        if (
          typeof row.backup_id !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(row.backup_id) ||
          typeof row.backup_sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(row.backup_sha256)
        )
          continue;
        const copy = resolve(
          '.local/portable-backups',
          row.backup_id + '.json',
        );
        if (!existsSync(copy) || statSync(copy).size > 64 * 1024 * 1024)
          continue;
        if (
          createHash('sha256').update(readFileSync(copy)).digest('hex') !==
          row.backup_sha256
        )
          continue;
        receipts.push(row);
      }
    } catch {
      /* Invalid history cannot qualify a fresh backup. */
    }
  }
}
const state = backupDue(receipts, new Date());
if (args[0] === '--check' || !state.due) {
  console.log(
    JSON.stringify({
      ...state,
      state: state.due ? 'DUE' : 'FRESH',
      backup_started: false,
      secret_values_recorded: false,
    }),
  );
} else {
  // Capture all diagnostics; the backup tool owns private bytes and redacted
  // immutable receipts. Never forward child output to scheduler logs.
  const child = spawnSync(
    process.execPath,
    ['--env-file=.env', '--import=tsx', 'tools/deployment/portable-backup.ts'],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 900000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    },
  );
  console.log(
    JSON.stringify({
      state: child.status === 0 ? 'VERIFIED' : 'BACKUP_FAILED',
      backup_started: true,
      secret_values_recorded: false,
    }),
  );
  if (child.status !== 0) process.exitCode = 2;
}
