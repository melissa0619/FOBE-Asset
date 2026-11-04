[CmdletBinding()]
param()

$taskName = 'FOBE API Server'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "'$taskName' is not installed. Nothing to remove."
    exit 0
}

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Host "Removed '$taskName'. No other scheduled tasks were changed."
