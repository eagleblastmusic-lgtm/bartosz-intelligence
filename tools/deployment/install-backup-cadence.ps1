param([switch]$Check, [switch]$Remove)
$ErrorActionPreference = 'Stop'
if ($Check -and $Remove) { throw 'INVALID_BACKUP_CADENCE_ARGUMENTS' }
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskLauncher = Join-Path $PSScriptRoot 'run-backup-cadence.ps1'
$taskShell = (Get-Command pwsh.exe).Source
$taskName = 'Bartosz Intelligence Verified Backup'
$taskArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $taskLauncher + '"'
$taskExisting = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($taskExisting -and ($taskExisting.Actions.Count -ne 1 -or $taskExisting.Actions[0].Execute -ne $taskShell -or $taskExisting.Actions[0].Arguments -ne $taskArguments -or $taskExisting.Actions[0].WorkingDirectory -ne $taskRoot)) { throw 'BACKUP_TASK_NAME_CONFLICT' }
if ($Check) { @{backup_task_registered=($null -ne $taskExisting);secret_values_recorded=$false} | ConvertTo-Json -Compress; exit 0 }
if ($Remove) {
  if ($taskExisting) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
  @{backup_task_registered=$false;existing_backups_preserved=$true} | ConvertTo-Json -Compress
  exit 0
}
& $taskLauncher -Check
if ($LASTEXITCODE -ne 0) { throw 'BACKUP_CONFIGURATION_REQUIRED' }
$taskUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskAction = New-ScheduledTaskAction -Execute $taskShell -Argument $taskArguments -WorkingDirectory $taskRoot
$taskTriggers = @((New-ScheduledTaskTrigger -AtLogOn -User $taskUser), (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval ([TimeSpan]::FromHours(1))))
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::FromMinutes(20)) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTriggers -Principal $taskPrincipal -Settings $taskSettings -Description 'Check verified backup freshness hourly and at owner logon; run existing private backup and restore verification when due. No AI or billing.' -Force | Out-Null
@{backup_task_registered=$true;check_cadence='HOURLY_AND_OWNER_LOGON';backup_due_after_hours=24;secret_values_recorded=$false} | ConvertTo-Json -Compress
