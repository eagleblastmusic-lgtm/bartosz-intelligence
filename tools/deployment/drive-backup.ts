import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
} from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { remoteDatabase } from './cloudflare.mjs';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { sha256, randomToken } from '../../packages/core/src/auth/crypto.js';
import {
  encryptCanonicalBackup,
  decryptCanonicalBackup,
  type EncryptedCanonicalBackup,
} from '../../packages/core/src/backup/encryption.js';
import {
  verifyPortableBackup,
  type PortableCoreBackup,
} from '../../packages/core/src/backup/restore.js';
import { importDriveWrappingKey } from '../../packages/core/src/drive/credentials.js';
import { refreshDriveAccess } from '../../packages/core/src/drive/oauth.js';
import {
  DriveClient,
  DriveFailure,
} from '../../packages/core/src/drive/client.js';
import { requirePrivateRecoveryDirectory } from '../db/private-directory.js';

// Upload only an authenticated encrypted envelope. The canonical backup/restore
// format and migrations remain owned by the existing backup mechanism.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--backup')
  throw new Error('EXPLICIT_CANONICAL_BACKUP_REQUIRED');
const config = JSON.parse(readFileSync('config/drive-backup.json', 'utf8')) as {
  enabled: boolean;
  folder_id: string;
  recovery_key_file: string;
  paid_services_enabled: false;
};
if (!config.enabled || config.paid_services_enabled !== false)
  throw new Error('DRIVE_BACKUP_DISABLED');
const recoveryFile = config.recovery_key_file.startsWith('%LOCALAPPDATA%\\')
  ? join(process.env.LOCALAPPDATA ?? '', config.recovery_key_file.slice(15))
  : config.recovery_key_file;
const keyPath = resolve(recoveryFile),
  inside = relative(process.cwd(), keyPath);
if (
  !isAbsolute(recoveryFile) ||
  (!inside.startsWith('..') && !isAbsolute(inside)) ||
  !existsSync(keyPath) ||
  lstatSync(keyPath).isSymbolicLink()
)
  throw new Error('EXTERNAL_RECOVERY_KEY_REQUIRED');
const saved = JSON.parse(readFileSync(keyPath, 'utf8')) as {
  version: string;
  key_id: string;
  key: string;
};
if (
  saved.version !== 'canonical-backup-recovery:1' ||
  !/^backup-[a-f0-9-]{36}$/.test(saved.key_id) ||
  !/^[A-Za-z0-9_-]{43}$/.test(saved.key)
)
  throw new Error('RECOVERY_KEY_INVALID');
// Existing owner/System-only recovery ACL must be in place before loading key.
const acl = spawnSync(
  'pwsh.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "$ErrorActionPreference='Stop'; try { $a=Get-Acl -LiteralPath $env:BI_BACKUP_KEY_PATH; $s=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if (@($a.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($s,'S-1-5-18') -or $_.AccessControlType -ne 'Allow' }).Count) {exit 1} } catch {exit 1}",
  ],
  {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, BI_BACKUP_KEY_PATH: keyPath },
    timeout: 15000,
  },
);
if (acl.status !== 0) throw new Error('RECOVERY_KEY_ACL_REQUIRED');
const rawKey = Buffer.from(saved.key, 'base64url');
const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, [
  'encrypt',
  'decrypt',
]);
rawKey.fill(0);
saved.key = '';
const original = readFileSync(resolve(args[1]!));
if (original.length > 64 * 1024 * 1024)
  throw new Error('BACKUP_FILE_TOO_LARGE');
const portable = JSON.parse(original.toString('utf8')) as PortableCoreBackup;
await verifyPortableBackup(portable);
const backupId = portable.manifest.backup_id,
  privateDirectory = resolve('.local/drive-backups');
requirePrivateRecoveryDirectory(privateDirectory);
mkdirSync(privateDirectory, { recursive: true });
const envelopePath = join(privateDirectory, backupId + '.bi-backup.json'),
  intentPath = join(privateDirectory, backupId + '-intent.json');
if (!existsSync(envelopePath))
  writeFileSync(
    envelopePath,
    JSON.stringify(
      await encryptCanonicalBackup(original, backupId, saved.key_id, key),
    ),
    { flag: 'wx', mode: 0o600 },
  );
const envelopeBytes = readFileSync(envelopePath),
  envelope = JSON.parse(
    envelopeBytes.toString('utf8'),
  ) as EncryptedCanonicalBackup;
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
if (digest(await decryptCanonicalBackup(envelope, key)) !== digest(original))
  throw new Error('ENCRYPTED_BACKUP_SOURCE_MISMATCH');
const db = remoteDatabase(),
  now = new Date(),
  session = await sha256(randomToken());
const connection = await db
  .prepare(
    "SELECT owner_id,connection_id FROM drive_connections WHERE auth_state='CONNECTED' LIMIT 1",
  )
  .first<{ owner_id: string; connection_id: string }>();
if (!connection) throw new Error('CONNECTED_DRIVE_REQUIRED');
await db
  .prepare(
    'INSERT INTO owner_sessions(session_hash,owner_id,csrf_hash,created_at,expires_at) VALUES(?,?,?,?,?)',
  )
  .bind(
    session,
    connection.owner_id,
    await sha256(randomToken()),
    now.toISOString(),
    new Date(now.getTime() + 900000).toISOString(),
  )
  .run();
try {
  const context = await AccessContext.owner(db, session, now.toISOString());
  const grant = await refreshDriveAccess(
    db,
    context,
    {
      client_id: process.env.GOOGLE_DRIVE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_DRIVE_CLIENT_SECRET!,
      app_origin: process.env.APP_ORIGIN!,
    },
    await importDriveWrappingKey(
      process.env.DRIVE_WRAPPING_KEY_ID!,
      process.env.DRIVE_WRAPPING_KEY!,
    ),
    connection.connection_id,
    new Date(),
  );
  const client = new DriveClient(grant.access_token);
  await client.verifyPrivateFolder(config.folder_id);
  if (!existsSync(intentPath))
    writeFileSync(
      intentPath,
      JSON.stringify({
        backup_id: backupId,
        folder_id: config.folder_id,
        file_id: await client.reserveId(),
        encrypted_sha256: digest(envelopeBytes),
      }),
      { flag: 'wx', mode: 0o600 },
    );
  const intent = JSON.parse(readFileSync(intentPath, 'utf8')) as {
    backup_id: string;
    folder_id: string;
    file_id: string;
    encrypted_sha256: string;
  };
  if (
    intent.backup_id !== backupId ||
    intent.folder_id !== config.folder_id ||
    intent.encrypted_sha256 !== digest(envelopeBytes)
  )
    throw new Error('BACKUP_UPLOAD_INTENT_MISMATCH');
  let created = false;
  try {
    await client.getFile(intent.file_id);
  } catch (error) {
    if (!(error instanceof DriveFailure && error.category === 'NOT_FOUND'))
      throw error;
    await client.createEncryptedBackup({
      reserved_id: intent.file_id,
      root_id: config.folder_id,
      backup_id: backupId,
      envelope_json: envelopeBytes.toString('utf8'),
    });
    created = true;
  }
  const before = await client.getFile(intent.file_id),
    download = await client.readEncryptedBackup(
      intent.file_id,
      envelopeBytes.length + 1,
    ),
    after = await client.getFile(intent.file_id);
  const downloaded = new TextEncoder().encode(download);
  if (
    before.version !== after.version ||
    !after.parents?.includes(config.folder_id) ||
    after.appProperties?.bi_backup !== backupId ||
    digest(downloaded) !== digest(envelopeBytes)
  )
    throw new Error('BACKUP_DRIVE_READBACK_MISMATCH');
  const plaintext = await decryptCanonicalBackup(JSON.parse(download), key);
  if (digest(plaintext) !== digest(original))
    throw new Error('BACKUP_DECRYPTED_HASH_MISMATCH');
  await verifyPortableBackup(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)),
  );
  const downloadedPath = join(privateDirectory, backupId + '-downloaded.json');
  if (!existsSync(downloadedPath))
    writeFileSync(downloadedPath, plaintext, { flag: 'wx', mode: 0o600 });
  else if (digest(readFileSync(downloadedPath)) !== digest(plaintext))
    throw new Error('BACKUP_DOWNLOAD_TARGET_CONFLICT');
  plaintext.fill(0);
  const report = {
    version: 'DriveCanonicalBackupReceipt/1.0',
    observed_at: new Date().toISOString(),
    status: 'PASS',
    backup_id: backupId,
    captured_at: portable.manifest.created_at,
    cut_seq: portable.manifest.cut_seq,
    folder_id: config.folder_id,
    file_id: intent.file_id,
    created,
    encrypted_bytes: envelopeBytes.length,
    encrypted_sha256: digest(envelopeBytes),
    canonical_sha256: digest(original),
    upload_download_hash: 'PASS',
    authenticated_decryption: 'PASS',
    portable_integrity: 'PASS',
    remote_version: after.version,
    key_outside_drive_d1_repository: true,
    recovery_key_id: saved.key_id,
    isolated_restore: 'NOT_RUN',
    full_app_rpo_rto: 'NOT_QUALIFIED',
    paid_services_enabled: false,
  };
  const receiptPath = 'docs/verification/backup/drive-' + backupId + '.json';
  if (!existsSync(receiptPath))
    writeFileSync(receiptPath, JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
    });
  else {
    const existing = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (
      existing.backup_id !== backupId ||
      existing.file_id !== intent.file_id ||
      existing.folder_id !== config.folder_id ||
      existing.encrypted_sha256 !== report.encrypted_sha256 ||
      existing.canonical_sha256 !== report.canonical_sha256
    )
      throw new Error('BACKUP_RECEIPT_CONFLICT');
  }
  console.log(JSON.stringify(report));
} finally {
  await db
    .prepare('UPDATE owner_sessions SET revoked_at=? WHERE session_hash=?')
    .bind(new Date().toISOString(), session)
    .run();
}
