param([switch]$Check, [switch]$Wait)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskNode = Join-Path $taskRoot '.tools/node-v24.21.0-win-x64/node.exe'
$taskLocal = Join-Path $taskRoot '.local'
$taskReceipt = Join-Path $taskLocal 'local-services-start.json'
Set-Location -LiteralPath $taskRoot
if (!(Test-Path -LiteralPath $taskNode) -or !(Test-Path -LiteralPath (Join-Path $taskRoot '.env'))) { throw 'LOCAL_SERVICE_CONFIGURATION_REQUIRED' }
$env:PATH = (Split-Path -Parent $taskNode) + ';' + $env:PATH
$taskProbe = & $taskNode '--import' 'tsx' '--env-file=.env' '--input-type=module' '-e' 'import {localServices,serviceEnvironment} from "./apps/executor/src/services.ts"; const selected=localServices.filter(s=>!!process.env[s.credential]); if(!selected.length) process.exit(1); for(const s of selected) serviceEnvironment(s,process.env); console.log(JSON.stringify({services:selected.map(s=>s.name)}));' 2>$null
if ($LASTEXITCODE -ne 0) { throw 'LOCAL_SERVICE_CONFIGURATION_REQUIRED' }
$taskConfiguration = $taskProbe | ConvertFrom-Json
$taskExisting = $null
if (Test-Path -LiteralPath $taskReceipt) {
  $taskRecorded = Get-Content -LiteralPath $taskReceipt -Raw | ConvertFrom-Json
  if ($taskRecorded.pid -isnot [long] -and $taskRecorded.pid -isnot [int]) { throw 'INVALID_LOCAL_SERVICE_RECEIPT' }
  $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($taskRecorded.pid)"
  if ($taskProcess) {
    if ($taskProcess.ExecutablePath -ne $taskNode -or $taskProcess.CommandLine -notlike '*tools/executor/run-services.ts*') { throw 'LOCAL_SERVICE_PID_CONFLICT' }
    $taskExisting = $taskProcess.ProcessId
  }
}
if ($Check) {
  @{ configuration_valid=$true; supervisor_running=($null -ne $taskExisting); services=$taskConfiguration.services; ai_services_started=$false; secret_values_recorded=$false } | ConvertTo-Json -Compress
  exit 0
}
if (!$taskExisting) {
  if (!(Test-Path -LiteralPath $taskLocal)) { New-Item -ItemType Directory -Path $taskLocal | Out-Null }
  $taskProcess = Start-Process -FilePath $taskNode -ArgumentList @('--import','tsx','--env-file=.env','tools/executor/run-services.ts') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskLocal 'local-services.log') -RedirectStandardError (Join-Path $taskLocal 'local-services-error.log') -PassThru
  $taskExisting = $taskProcess.Id
  @{pid=$taskExisting;started_at=[DateTime]::UtcNow.ToString('o');services=$taskConfiguration.services;ai_services_started=$false} | ConvertTo-Json | Set-Content -LiteralPath $taskReceipt
}
@{ supervisor_running=$true; services=$taskConfiguration.services; ai_services_started=$false; secret_values_recorded=$false } | ConvertTo-Json -Compress
if ($Wait) { Wait-Process -Id $taskExisting -ErrorAction SilentlyContinue }
