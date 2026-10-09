import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { backupDue, type BackupReceipt } from './backup-cadence.js';

const args = process.argv.slice(2);
if (args.length !== 1 || !['--check', '--run-if-due'].includes(args[0]!))
  throw new Error('EXPLICIT_BACKUP_CADENCE_MODE_REQUIRED');
const root = resolve('docs/verification/backup');
const receipts: (BackupReceipt & { backup_id: string })[] = [];
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
        receipts.push(row as BackupReceipt & { backup_id: string });
      }
    } catch {
      /* Invalid history cannot qualify a fresh backup. */
    }
  }
}
const state = backupDue(receipts, new Date());
function archiveOnDrive(backupId: string | undefined) {
  if (!existsSync('config/drive-backup.json')) return 'DISABLED';
  const config = JSON.parse(readFileSync('config/drive-backup.json', 'utf8'));
  if (config.enabled !== true) return 'DISABLED';
  if (!backupId || !/^[a-f0-9-]{36}$/.test(backupId)) return 'BACKUP_REQUIRED';
  const receiptPath = 'docs/verification/backup/drive-' + backupId + '.json';
  if (existsSync(receiptPath)) {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (
      receipt.status === 'PASS' &&
      receipt.folder_id === config.folder_id &&
      receipt.format === config.format
    )
      return 'ALREADY_VERIFIED';
  }
  const uploaded = spawnSync(
    process.execPath,
    [
      '--env-file=.env',
      '--import=tsx',
      'tools/deployment/drive-backup.ts',
      '--backup',
      resolve('.local/portable-backups', backupId + '.json'),
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 900000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    },
  );
  return uploaded.status === 0 ? 'VERIFIED' : 'ARCHIVE_FAILED';
}
if (args[0] === '--check' || !state.due) {
  const latest = receipts.find(
    (row) =>
      backupDue([row], new Date()).latest_verified_at ===
      state.latest_verified_at,
  );
  const archive =
    args[0] === '--run-if-due'
      ? archiveOnDrive(latest?.backup_id)
      : 'NOT_REQUESTED';
  console.log(
    JSON.stringify({
      ...state,
      state: state.due ? 'DUE' : 'FRESH',
      backup_started: false,
      secret_values_recorded: false,
      drive_archive: archive,
    }),
  );
  if (['ARCHIVE_FAILED', 'BACKUP_REQUIRED'].includes(archive))
    process.exitCode = 2;
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
  let completedId: string | undefined;
  if (child.status === 0) {
    try {
      const receipt = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)!);
      if (receipt.version === 'portable-backup-drill:1')
        completedId = receipt.backup_id;
    } catch {
      /* Missing receipt cannot qualify an archive upload. */
    }
  }
  const archive =
    child.status === 0 ? archiveOnDrive(completedId) : 'NOT_REQUESTED';
  console.log(
    JSON.stringify({
      state: child.status === 0 ? 'VERIFIED' : 'BACKUP_FAILED',
      backup_started: true,
      secret_values_recorded: false,
      drive_archive: archive,
    }),
  );
  if (
    child.status !== 0 ||
    ['ARCHIVE_FAILED', 'BACKUP_REQUIRED'].includes(archive)
  )
    process.exitCode = 2;
}
