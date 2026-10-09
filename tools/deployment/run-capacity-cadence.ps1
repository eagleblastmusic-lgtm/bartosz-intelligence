param([switch]$Check)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskNode = Join-Path $taskRoot '.tools/node-v24.21.0-win-x64/node.exe'
Set-Location -LiteralPath $taskRoot
if (!(Test-Path -LiteralPath $taskNode) -or !(Test-Path -LiteralPath (Join-Path $taskRoot '.env'))) { throw 'CAPACITY_CONFIGURATION_REQUIRED' }
if ($Check) {
  & $taskNode '--env-file=.env' '-e' 'if (!/^[A-Za-z0-9_-]{43}$/.test(process.env.LOCAL_TELEMETRY_WORKER_CREDENTIAL || "")) process.exit(2)'
  if ($LASTEXITCODE -ne 0) { throw 'CAPACITY_CONFIGURATION_REQUIRED' }
  '{"configuration_present":true,"ai_requests":0,"secret_values_recorded":false}'
  exit 0
}
$taskMutex = [Threading.Mutex]::new($false, 'Local\BartoszIntelligenceCapacityCadence')
$taskAcquired = $false
try {
  try { $taskAcquired = $taskMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $taskAcquired = $true }
  if (!$taskAcquired) { '{"state":"ALREADY_RUNNING","secret_values_recorded":false}'; exit 0 }
  & $taskNode '--env-file=.env' '--import=tsx' 'tools/gates/capacity/collect.ts' 'config/capacity-collector.json' '.local/capacity-observation'
  exit $LASTEXITCODE
} finally {
  if ($taskAcquired) { $taskMutex.ReleaseMutex() }
  $taskMutex.Dispose()
}
