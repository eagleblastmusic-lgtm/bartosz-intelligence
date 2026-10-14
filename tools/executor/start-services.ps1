param([switch]$Check, [switch]$Wait, [switch]$Restart)
$ErrorActionPreference = 'Stop'
if ($Check -and $Restart) { throw 'INVALID_LOCAL_SERVICE_ARGUMENTS' }
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskNode = Join-Path $taskRoot '.tools/node-v24.21.0-win-x64/node.exe'
$taskLocal = Join-Path $taskRoot '.local'
$taskReceipt = Join-Path $taskLocal 'local-services-start.json'
Set-Location -LiteralPath $taskRoot
if (!(Test-Path -LiteralPath $taskNode) -or !(Test-Path -LiteralPath (Join-Path $taskRoot '.env'))) { throw 'LOCAL_SERVICE_CONFIGURATION_REQUIRED' }
$env:PATH = (Split-Path -Parent $taskNode) + ';' + $env:PATH
if (!$env:BARTOSZ_PYTHONPATH) { $env:BARTOSZ_PYTHONPATH = Join-Path $taskRoot '.tools/gate0-python' }
$taskProbe = & $taskNode '--import' 'tsx' '--env-file=.env' '--input-type=module' '-e' 'import {localServices,serviceEnvironment} from "./apps/executor/src/services.ts"; import {isAbsolute} from "node:path"; import {existsSync} from "node:fs"; const selected=localServices.filter(s=>!!process.env[s.credential]); if(!selected.length) process.exit(1); const transcript=selected.some(s=>s.name==="transcript"); if(transcript) { const python=process.env.BARTOSZ_PYTHON??"C:/Python314/python.exe"; if(!isAbsolute(python)||!existsSync(python)) process.exit(1); process.env.BARTOSZ_PYTHON=python; } for(const s of selected) serviceEnvironment(s,process.env); console.log(JSON.stringify({services:selected.map(s=>s.name),...(transcript?{python:process.env.BARTOSZ_PYTHON}:{})}));' 2>$null
if ($LASTEXITCODE -ne 0) { throw 'LOCAL_SERVICE_CONFIGURATION_REQUIRED' }
$taskConfiguration = $taskProbe | ConvertFrom-Json
if ($taskConfiguration.python) { $env:BARTOSZ_PYTHON = $taskConfiguration.python }
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
if ($Restart -and $taskExisting) {
  # Only this verified supervisor and its scoped Node children are stopped.
  # Durable D1 leases recover interrupted jobs; no credential or process command
  # line is printed. Unknown children fail closed before stopping anything.
  $taskChildren = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$taskExisting")
  $taskRunner = (Join-Path $taskRoot 'tools/executor/run-local.ts').Replace('\','/')
  $taskConsoleHost = Join-Path $env:SystemRoot 'System32/conhost.exe'
  foreach ($taskChild in $taskChildren) {
    if ($taskChild.ExecutablePath -eq $taskConsoleHost) { continue }
    if ($taskChild.ExecutablePath -ne $taskNode -or !$taskChild.CommandLine -or $taskChild.CommandLine.Replace('\','/').IndexOf($taskRunner,[StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'LOCAL_SERVICE_CHILD_CONFLICT' }
  }
  Stop-Process -Id $taskExisting -ErrorAction SilentlyContinue
  foreach ($taskChild in $taskChildren) {
    $taskCurrent = Get-CimInstance Win32_Process -Filter "ProcessId=$($taskChild.ProcessId)"
    if ($taskChild.ExecutablePath -eq $taskNode -and $taskCurrent -and $taskCurrent.CreationDate -eq $taskChild.CreationDate -and $taskCurrent.ExecutablePath -eq $taskNode) {
      Stop-Process -Id $taskChild.ProcessId -ErrorAction SilentlyContinue
    }
  }
  $taskExisting = $null
}
if (!$taskExisting) {
  if (!(Test-Path -LiteralPath $taskLocal)) { New-Item -ItemType Directory -Path $taskLocal | Out-Null }
  $taskProcess = Start-Process -FilePath $taskNode -ArgumentList @('--import','tsx','--env-file=.env','tools/executor/run-services.ts') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskLocal 'local-services.log') -RedirectStandardError (Join-Path $taskLocal 'local-services-error.log') -PassThru
  $taskExisting = $taskProcess.Id
  @{pid=$taskExisting;started_at=[DateTime]::UtcNow.ToString('o');services=$taskConfiguration.services;ai_services_started=$false} | ConvertTo-Json | Set-Content -LiteralPath $taskReceipt
}
@{ supervisor_running=$true; services=$taskConfiguration.services; ai_services_started=$false; secret_values_recorded=$false } | ConvertTo-Json -Compress
if ($Wait) { Wait-Process -Id $taskExisting -ErrorAction SilentlyContinue }
