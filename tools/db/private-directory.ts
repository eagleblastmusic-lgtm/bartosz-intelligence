import { spawnSync } from 'node:child_process';
import { resolve, relative, isAbsolute } from 'node:path';

/** Windows private recovery bytes must not inherit a broadly readable ACL. */
export function requirePrivateRecoveryDirectory(directory: string) {
  if (process.platform !== 'win32')
    throw new Error('PRIVATE_WINDOWS_RECOVERY_REQUIRED');
  const root = resolve('.local');
  const target = resolve(directory);
  const path = relative(root, target);
  if (!path || isAbsolute(path) || path === '..' || path.startsWith('..\\'))
    throw new Error('PRIVATE_RECOVERY_TARGET_REQUIRED');
  const result = spawnSync(
    'pwsh.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `
$ErrorActionPreference='Stop'
try {
$target=$env:BI_PRIVATE_RECOVERY_DIRECTORY
$root=$env:BI_PRIVATE_RECOVERY_ROOT
$current=$target
while ($true) {
  if ((Test-Path -LiteralPath $current) -and ((Get-Item -LiteralPath $current).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'REPARSE_POINT' }
  if ($current -eq $root) { break }
  $current=Split-Path -Parent $current
  if (!$current) { throw 'INVALID_ROOT' }
}
if (!(Test-Path -LiteralPath $target)) { New-Item -ItemType Directory -Path $target | Out-Null }
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
      env: {
        ...process.env,
        BI_PRIVATE_RECOVERY_DIRECTORY: target,
        BI_PRIVATE_RECOVERY_ROOT: root,
      },
    },
  );
  if (result.status !== 0) throw new Error('PRIVATE_RECOVERY_ACL_REQUIRED');
}
