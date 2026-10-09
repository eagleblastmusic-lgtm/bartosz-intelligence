param([switch]$Check, [switch]$Remove)
$ErrorActionPreference = 'Stop'
if ($Check -and $Remove) { throw 'INVALID_CAPACITY_CADENCE_ARGUMENTS' }
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskLauncher = Join-Path $PSScriptRoot 'run-capacity-cadence.ps1'
$taskShell = (Get-Command pwsh.exe).Source
$taskName = 'Bartosz Intelligence Capacity Observation'
$taskArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $taskLauncher + '"'
$taskExisting = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($taskExisting -and ($taskExisting.Actions.Count -ne 1 -or $taskExisting.Actions[0].Execute -ne $taskShell -or $taskExisting.Actions[0].Arguments -ne $taskArguments -or $taskExisting.Actions[0].WorkingDirectory -ne $taskRoot)) { throw 'CAPACITY_TASK_NAME_CONFLICT' }
if ($Check) { @{capacity_task_registered=($null -ne $taskExisting);secret_values_recorded=$false} | ConvertTo-Json -Compress; exit 0 }
if ($Remove) {
  if ($taskExisting) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
  @{capacity_task_registered=$false;existing_evidence_preserved=$true} | ConvertTo-Json -Compress
  exit 0
}
& $taskLauncher -Check
if (!$?) { throw 'CAPACITY_CONFIGURATION_REQUIRED' }
$taskUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskAction = New-ScheduledTaskAction -Execute $taskShell -Argument $taskArguments -WorkingDirectory $taskRoot
$taskTriggers = @((New-ScheduledTaskTrigger -AtLogOn -User $taskUser), (New-ScheduledTaskTrigger -Once -At (Get-Date).AddHours(1) -RepetitionInterval ([TimeSpan]::FromHours(1))))
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::FromMinutes(10)) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTriggers -Principal $taskPrincipal -Settings $taskSettings -Description 'Read-only production Gate C observations hourly and at owner logon. No AI; offline periods remain evidence gaps.' -Force | Out-Null
@{capacity_task_registered=$true;cadence='HOURLY_AND_OWNER_LOGON';requires_logged_on_powered_computer=$true;ai_requests=0;secret_values_recorded=$false} | ConvertTo-Json -Compress
