import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  importDriveWrappingKey,
  encryptDriveRefreshToken,
  decryptDriveRefreshToken,
} from '../../packages/core/src/drive/credentials.js';

const directory = process.argv[2];
const publishingStatus =
  process.argv[3] ?? process.env.GOOGLE_DRIVE_OAUTH_PUBLISHING_STATUS;
if (
  !publishingStatus ||
  !['TESTING', 'PRODUCTION', 'INTERNAL'].includes(publishingStatus)
)
  throw new Error('OAUTH_PUBLISHING_STATUS_REQUIRED');
if (process.platform !== 'win32' || !directory || !isAbsolute(directory))
  throw new Error('PRIVATE_WINDOWS_RECOVERY_DIRECTORY_REQUIRED');
const target = resolve(directory);
const fromRepository = relative(process.cwd(), target);
if (!fromRepository.startsWith('..') && !isAbsolute(fromRepository))
  throw new Error('RECOVERY_MUST_BE_OUTSIDE_REPOSITORY');
// Protect the owner-selected directory before writing any key. PowerShell
// receives only the path; credential values never enter arguments or output.
const acl = spawnSync(
  'pwsh.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `
$ErrorActionPreference='Stop'
try {
$target=$env:BI_PRIVATE_RECOVERY_DIRECTORY
if (!(Test-Path -LiteralPath $target)) { New-Item -ItemType Directory -Path $target -Force | Out-Null }
if ((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'RECOVERY_REPARSE_POINT_DENIED' }
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().User
& icacls.exe $target '/inheritance:r' '/grant:r' "*$($identity.Value):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'RECOVERY_ACCESS_RULE_UPDATE_FAILED' }
$verified=Get-Acl -LiteralPath $target
if (!$verified.AreAccessRulesProtected -or @($verified.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($identity.Value,'S-1-5-18') }).Count) { throw 'RECOVERY_ACL_NOT_PRIVATE' }
$keyfile=Join-Path $target 'drive-wrapping-key-v1.json'
if (Test-Path -LiteralPath $keyfile) {
if ((Get-Item -LiteralPath $keyfile).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'RECOVERY_REPARSE_POINT_DENIED' }
$fileacl=Get-Acl -LiteralPath $keyfile
if (@($fileacl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($identity.Value,'S-1-5-18') -or $_.AccessControlType -ne 'Allow' }).Count) { throw 'RECOVERY_FILE_ACL_NOT_PRIVATE' }
}
} catch { Write-Output $_.FullyQualifiedErrorId; exit 1 }
`,
  ],
  {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    env: { ...process.env, BI_PRIVATE_RECOVERY_DIRECTORY: target },
  },
);
if (acl.status !== 0)
  throw new Error(
    'PRIVATE_RECOVERY_ACL_REQUIRED_' +
      (acl.error
        ? (acl.error as NodeJS.ErrnoException).code
        : /^[A-Za-z0-9_,.]+$/.test(acl.stdout.trim())
          ? acl.stdout.trim()
          : acl.status),
  );
const filename = join(target, 'drive-wrapping-key-v1.json');
if (existsSync(filename) && lstatSync(filename).isSymbolicLink())
  throw new Error('RECOVERY_REPARSE_POINT_DENIED');
let recovery: { version: string; key_id: string; key: string };
if (existsSync(filename)) {
  try {
    recovery = JSON.parse(readFileSync(filename, 'utf8'));
  } catch {
    throw new Error('RECOVERY_KEY_INVALID');
  }
} else {
  if (process.env.DRIVE_WRAPPING_KEY || process.env.DRIVE_WRAPPING_KEY_ID)
    throw new Error('EXISTING_KEY_REQUIRES_EXPLICIT_RECOVERY');
  recovery = {
    version: 'drive-wrapping-recovery:1',
    key_id: 'drive-' + randomUUID(),
    key: randomBytes(32).toString('base64url'),
  };
  writeFileSync(filename, JSON.stringify(recovery) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
}
if (
  recovery.version !== 'drive-wrapping-recovery:1' ||
  (process.env.DRIVE_WRAPPING_KEY &&
    process.env.DRIVE_WRAPPING_KEY !== recovery.key) ||
  (process.env.DRIVE_WRAPPING_KEY_ID &&
    process.env.DRIVE_WRAPPING_KEY_ID !== recovery.key_id)
)
  throw new Error('RECOVERY_KEY_MISMATCH');
const key = await importDriveWrappingKey(recovery.key_id, recovery.key);
let copy: typeof recovery;
try {
  copy = JSON.parse(readFileSync(filename, 'utf8'));
} catch {
  throw new Error('RECOVERY_KEY_INVALID');
}
const recovered = await importDriveWrappingKey(copy.key_id, copy.key);
const binding = {
  owner_id: 'recovery-check',
  connection_id: 'recovery-check',
  account_subject: 'synthetic-account',
  client_id: 'synthetic-client',
};
const envelope = await encryptDriveRefreshToken(
  'synthetic-recovery-verification',
  binding,
  key,
);
if (
  (await decryptDriveRefreshToken(envelope, binding, recovered)) !==
  'synthetic-recovery-verification'
)
  throw new Error('RECOVERY_ROUNDTRIP_FAILED');
let local = readFileSync('.env', 'utf8');
for (const [name, value] of Object.entries({
  DRIVE_WRAPPING_KEY_ID: recovery.key_id,
  DRIVE_WRAPPING_KEY: recovery.key,
  DRIVE_KEY_RECOVERY_READY: 'true',
  GOOGLE_DRIVE_OAUTH_PUBLISHING_STATUS: publishingStatus,
})) {
  const line = new RegExp('^' + name + '=.*$', 'm');
  local = line.test(local)
    ? local.replace(line, name + '=' + value)
    : local + '\n' + name + '=' + value + '\n';
}
writeFileSync('.env', local, { mode: 0o600 });
console.log(
  JSON.stringify({
    recovery_copy_present: true,
    private_acl: 'PASS',
    key_roundtrip: 'PASS',
    secrets_persisted: true,
    oauth_publishing_status: publishingStatus,
  }),
);
