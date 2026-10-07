# Registers the GB Logix server as a scheduled task that runs at startup, on battery too, with no time limit.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$run = Join-Path $PSScriptRoot 'run-server.bat'

# Power: never sleep / hibernate on AC power; closing the lid does nothing on AC power.
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 | Out-Null
powercfg /setactive SCHEME_CURRENT | Out-Null

$user = "$env:USERDOMAIN\$env:USERNAME"
Write-Host "Enter the password you use to sign in to Windows ($user) - not your PIN."
$cred = Get-Credential -UserName $user -Message 'GB Logix server: your Windows sign-in password (so it can start before anyone signs in)'
if (-not $cred) { throw 'No password entered.' }
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$run`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'GB Logix Server' -Action $action -Trigger $trigger -Settings $settings -User $cred.UserName `
  -Password $cred.GetNetworkCredential().Password -RunLevel Highest -Force | Out-Null

# Stop a copy started by hand (start-windows.bat) so the port is free, then start the task.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*src*server.js*' } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
Start-ScheduledTask -TaskName 'GB Logix Server'
Write-Host 'GB Logix Server task registered and started.'

# Cloudflare Tunnel (if installed): start after the network is up and restart itself if it stops (avoids error 1033 after a reboot).
if (Get-Service -Name cloudflared -ErrorAction SilentlyContinue) {
  sc.exe config cloudflared start= delayed-auto | Out-Null
  sc.exe failure cloudflared reset= 86400 actions= restart/10000/restart/30000/restart/60000 | Out-Null
  Start-Service cloudflared -ErrorAction SilentlyContinue
  Write-Host 'Cloudflare Tunnel service set to delayed start with automatic restart.'
}
