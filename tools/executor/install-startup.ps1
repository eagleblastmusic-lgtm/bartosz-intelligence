param([switch]$Check, [switch]$Remove)
$ErrorActionPreference = 'Stop'
if ($Check -and $Remove) { throw 'INVALID_STARTUP_ARGUMENTS' }
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskLauncher = Join-Path $PSScriptRoot 'start-services.ps1'
$taskShell = (Get-Command pwsh.exe).Source
$taskName = 'Bartosz Intelligence Local Executor'
$taskArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $taskLauncher + '" -Wait'
$taskExisting = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($taskExisting -and ($taskExisting.Actions.Count -ne 1 -or $taskExisting.Actions[0].Execute -ne $taskShell -or $taskExisting.Actions[0].Arguments -ne $taskArguments -or $taskExisting.Actions[0].WorkingDirectory -ne $taskRoot)) { throw 'STARTUP_TASK_NAME_CONFLICT' }
if ($Check) {
  @{ startup_registered=($null -ne $taskExisting); secret_values_recorded=$false } | ConvertTo-Json -Compress
  exit 0
}
if ($Remove) {
  if ($taskExisting) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
  @{ startup_registered=$false; running_services_stopped=$false } | ConvertTo-Json -Compress
  exit 0
}
& $taskLauncher -Check
if (!$?) { throw 'LOCAL_SERVICE_CONFIGURATION_REQUIRED' }
$taskUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskAction = New-ScheduledTaskAction -Execute $taskShell -Argument $taskArguments -WorkingDirectory $taskRoot
$taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $taskUser
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Description 'Scoped local transcript, source correction and search services. AI is not started.' -Force | Out-Null
@{ startup_registered=$true; trigger='OWNER_LOGON'; execution_time_limit='NONE'; ai_services_started=$false; secret_values_recorded=$false } | ConvertTo-Json -Compress
