param([switch]$Check)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskNode = Join-Path $taskRoot '.tools/node-v24.21.0-win-x64/node.exe'
Set-Location -LiteralPath $taskRoot
if (!(Test-Path -LiteralPath $taskNode) -or !(Test-Path -LiteralPath (Join-Path $taskRoot '.env'))) { throw 'BACKUP_CONFIGURATION_REQUIRED' }
$taskMutex = [Threading.Mutex]::new($false, 'Local\BartoszIntelligenceBackupCadence')
$taskAcquired = $false
try {
  try { $taskAcquired = $taskMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $taskAcquired = $true }
  if (!$taskAcquired) { '{"state":"ALREADY_RUNNING","secret_values_recorded":false}'; exit 0 }
  $taskMode = if ($Check) { '--check' } else { '--run-if-due' }
  $env:WRANGLER_SEND_METRICS = 'false'
  $env:CLOUDFLARE_ACCOUNT_ID = '0db26be1cc4c4f7f196d5ac401e232f3'
  & $taskNode '--env-file=.env' '--import=tsx' 'tools/deployment/backup-cadence-run.ts' $taskMode
  if ($LASTEXITCODE -ne 0) { exit 2 }
} finally {
  if ($taskAcquired) { $taskMutex.ReleaseMutex() }
  $taskMutex.Dispose()
}
