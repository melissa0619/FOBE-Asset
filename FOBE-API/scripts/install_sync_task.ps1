[CmdletBinding()]
param(
    [string]$TaskName = 'FOBE Asset Synchronization',
    [datetime]$SyncTime = (Get-Date '03:00'),
    [ValidateRange(1, 1440)]
    [int]$RepeatEveryMinutes = 30
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$python = Join-Path $projectRoot '.venv\Scripts\python.exe'
$syncScript = Join-Path $projectRoot 'main.py'

if (-not (Test-Path -LiteralPath $python)) {
    throw "Virtual-environment Python was not found: $python"
}
if (-not (Test-Path -LiteralPath $syncScript)) {
    throw "Synchronization script was not found: $syncScript"
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $python -Argument ('"{0}"' -f $syncScript) -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $SyncTime
# A daily calendar trigger plus this repetition pattern starts a sync every
# 30 minutes throughout each day. It avoids maintaining 48 separate triggers.
$trigger.Repetition.Interval = "PT$($RepeatEveryMinutes)M"
$trigger.Repetition.Duration = 'P1D'
$trigger.Repetition.StopAtDurationEnd = $false
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 5) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Updating existing '$TaskName' task."
} else {
    Write-Host "Creating '$TaskName' task."
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description 'Runs the local itemit-to-SQLite asset synchronization.' -Force | Out-Null

Write-Host "Installed '$TaskName'. It will run every $RepeatEveryMinutes minutes, beginning daily at $($SyncTime.ToString('h:mm tt'))."
Write-Host "Verify without starting it: Get-ScheduledTaskInfo -TaskName '$TaskName'"
