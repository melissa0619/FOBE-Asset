[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$taskName = 'FOBE API Server'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$python = Join-Path $projectRoot '..\.venv\Scripts\python.exe'
$launcher = Join-Path $projectRoot 'scripts\start_api.py'

if (-not (Test-Path -LiteralPath $python)) {
    throw "Virtual-environment Python was not found: $python"
}
if (-not (Test-Path -LiteralPath $launcher)) {
    throw "API launcher was not found: $launcher"
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $python -Argument ('"{0}"' -f $launcher) -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Updating existing '$taskName' task."
} else {
    Write-Host "Creating '$taskName' task."
}

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Installed '$taskName'. Verify with:"
Write-Host "Get-ScheduledTaskInfo -TaskName '$taskName'"
Write-Host "Start-ScheduledTask -TaskName '$taskName'"
