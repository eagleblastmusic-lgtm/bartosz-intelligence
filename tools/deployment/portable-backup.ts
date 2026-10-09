import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { remoteDatabase } from './cloudflare.mjs';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { randomToken, sha256 } from '../../packages/core/src/auth/crypto.js';
import {
  CoreBackup,
  backupTables,
  type BackupChunk,
} from '../../packages/core/src/backup/snapshot.js';
import {
  restoreCanonical,
  verifyPortableBackup,
} from '../../packages/core/src/backup/restore.js';
import { sqliteAdapter } from '../db/sqlite-adapter.js';
import ledger from '../../db/migration-ledger.json';
import {
  recoverBackupChunk,
  recoverBackupCompletion,
} from './backup-recovery.js';

// Explicit administrative backup/restore drill. Never an unattended deployment
// side effect. Private data stays on this host; only redacted receipts enter Git.
if (process.platform !== 'win32')
  throw new Error('PRIVATE_WINDOWS_BACKUP_REQUIRED');
const directory = resolve('.local/portable-backups');
const acl = spawnSync(
  'pwsh.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `
$ErrorActionPreference='Stop'
try {
$target=$env:BI_PRIVATE_BACKUP_DIRECTORY
if (!(Test-Path -LiteralPath $target)) { New-Item -ItemType Directory -Path $target | Out-Null }
if ((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'REPARSE_POINT' }
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().User
& icacls.exe $target '/inheritance:r' '/grant:r' "*$($identity.Value):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'ACL_FAILED' }
$verified=Get-Acl -LiteralPath $target
if (!$verified.AreAccessRulesProtected -or @($verified.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($identity.Value,'S-1-5-18') -or $_.AccessControlType -ne 'Allow' }).Count) { throw 'ACL_NOT_PRIVATE' }
} catch { exit 1 }
`,
  ],
  {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    env: { ...process.env, BI_PRIVATE_BACKUP_DIRECTORY: directory },
  },
);
if (acl.status !== 0) throw new Error('PRIVATE_BACKUP_ACL_REQUIRED');
const db = remoteDatabase(),
  now = new Date(),
  sessionHash = await sha256(randomToken());
const drillStarted = performance.now();
let backup: CoreBackup | undefined,
  backupId: string | undefined,
  verifiedRemote = false,
  sessionCreated = false,
  phase = 'OWNER',
  chunkTable: string | null = null,
  chunkCursor: number | null = null;
try {
  const owners = await db
    .prepare(
      'SELECT owner_id,subject FROM owner_users WHERE allowlisted=1 LIMIT 2',
    )
    .all<{ owner_id: string; subject: string }>();
  if (owners.results.length !== 1) throw new Error('VERIFIED_OWNER_REQUIRED');
  const owner = owners.results[0]!;
  await db
    .prepare(
      'INSERT INTO owner_sessions(session_hash,owner_id,csrf_hash,created_at,expires_at) VALUES(?,?,?,?,?)',
    )
    .bind(
      sessionHash,
      owner.owner_id,
      await sha256(randomToken()),
      now.toISOString(),
      new Date(now.getTime() + 900000).toISOString(),
    )
    .run();
  sessionCreated = true;
  phase = 'BEGIN';
  const context = await AccessContext.owner(
    db,
    sessionHash,
    new Date().toISOString(),
  );
  backup = new CoreBackup(db, context);
  const started = await backup.begin(2);
  backupId = started.backup_id;
  phase = 'CHUNKS';
  const chunks: BackupChunk[] = [];
  for (const table of backupTables) {
    let cursor: number | null = 0;
    do {
      if (chunks.length >= 2048 || Date.now() >= Date.parse(started.expires_at))
        throw new Error('BOUNDED_BACKUP_EXPIRED');
      chunkTable = table;
      chunkCursor = cursor;
      const chunk = await recoverBackupChunk(
        () => backup!.chunk(backupId!, table, cursor!),
        started.expires_at,
      );
      chunks.push(chunk);
      cursor = chunk.next_cursor;
    } while (cursor !== null);
  }
  phase = 'MANIFEST';
  const manifest = await recoverBackupCompletion(
    () => backup!.complete(backupId!),
    () => backup!.manifest(backupId!),
    started.expires_at,
  );
  verifiedRemote = true;
  const portable = { manifest, chunks };
  await verifyPortableBackup(portable);
  const bytes = Buffer.from(JSON.stringify(portable));
  if (bytes.length > 64 * 1024 * 1024) throw new Error('BACKUP_FILE_TOO_LARGE');
  const filename = join(directory, backupId + '.json');
  writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 });
  phase = 'PRIVATE_COPY_READBACK';
  const copied = readFileSync(filename);
  const digest = (value: Uint8Array) =>
    createHash('sha256').update(value).digest('hex');
  if (digest(copied) !== digest(bytes)) throw new Error('BACKUP_COPY_MISMATCH');
  const backupElapsedMs = Math.ceil(performance.now() - drillStarted);
  phase = 'INDEPENDENT_SQLITE_RESTORE';
  const restoreStarted = performance.now();
  const restorePath = join(directory, backupId + '.sqlite');
  if (existsSync(restorePath)) throw new Error('RESTORE_TARGET_EXISTS');
  const target = new DatabaseSync(restorePath);
  let result: Awaited<ReturnType<typeof restoreCanonical>>;
  try {
    target.exec('PRAGMA foreign_keys=ON');
    for (const migration of ledger.migrations) {
      const sql = readFileSync('db/migrations/' + migration.name);
      if (digest(sql) !== migration.sha256)
        throw new Error('MIGRATION_CHECKSUM_MISMATCH');
      target.exec(sql.toString('utf8'));
    }
    result = await restoreCanonical(
      sqliteAdapter(target),
      portable,
      owner.subject,
    );
    if (
      target.prepare('PRAGMA integrity_check').get()?.integrity_check !==
        'ok' ||
      target.prepare('PRAGMA foreign_key_check').all().length
    )
      throw new Error('RESTORE_INTEGRITY_FAILED');
  } finally {
    target.close();
  }
  const receipt = {
    version: 'portable-backup-drill:1',
    recorded_at: new Date().toISOString(),
    captured_at: manifest.created_at,
    backup_id: backupId,
    format_version: 2,
    backup_sha256: digest(copied),
    file_bytes: copied.length,
    canonical_bytes: result.bytes,
    canonical_rows: result.rows,
    chunks: chunks.length,
    consistent_cut_seq: manifest.cut_seq,
    migration_count: ledger.migrations.length,
    private_copy_readback: 'PASS',
    independent_sqlite_restore: 'PASS',
    integrity_check: 'PASS',
    foreign_key_check: 'PASS',
    active_sessions_restored: 0,
    active_worker_credentials_restored: 0,
    private_acl: 'OWNER_SYSTEM_ONLY',
    independent_medium: 'NOT_VERIFIED',
    production_worker_cpu: 'NOT_MEASURED: administrative D1 REST bridge',
    backup_elapsed_ms: backupElapsedMs,
    isolated_restore_elapsed_ms: Math.ceil(performance.now() - restoreStarted),
    drill_elapsed_ms: Math.ceil(performance.now() - drillStarted),
    rpo_rto: 'NOT_QUALIFIED',
    secret_values_recorded: false,
  };
  const evidenceDirectory = 'docs/verification/backup';
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(
    join(evidenceDirectory, receipt.recorded_at.replaceAll(':', '-') + '.json'),
    JSON.stringify(receipt, null, 2) + '\n',
    { flag: 'wx' },
  );
  process.stdout.write(JSON.stringify(receipt) + '\n');
} catch (error) {
  const failure = {
    result: 'FAIL',
    phase,
    chunk_table: phase === 'CHUNKS' ? chunkTable : null,
    chunk_cursor: phase === 'CHUNKS' ? chunkCursor : null,
    reason:
      error instanceof Error && /^[A-Z][A-Z0-9_]{1,100}$/.test(error.message)
        ? error.message
        : 'BACKUP_DRILL_FAILED',
    backup_id: backupId ?? null,
    recorded_at: new Date().toISOString(),
    secret_values_recorded: false,
  };
  mkdirSync('docs/verification/backup', { recursive: true });
  writeFileSync(
    join(
      'docs/verification/backup',
      failure.recorded_at.replaceAll(':', '-') + '-fail.json',
    ),
    JSON.stringify(failure, null, 2) + '\n',
    { flag: 'wx' },
  );
  process.stdout.write(JSON.stringify(failure) + '\n');
  process.exitCode = 1;
} finally {
  if (backup && backupId && !verifiedRemote)
    await backup.abort(backupId).catch(() => undefined);
  if (sessionCreated)
    await db
      .prepare('UPDATE owner_sessions SET revoked_at=? WHERE session_hash=?')
      .bind(new Date().toISOString(), sessionHash)
      .run()
      .catch(() => {
        // The session expires after 15 minutes. Preserve the primary failure and
        // report cleanup separately without leaking SQL or credentials.
        console.error(
          JSON.stringify({
            cleanup: 'SESSION_REVOCATION_FAILED',
            session_expiry_minutes: 15,
          }),
        );
      });
}
