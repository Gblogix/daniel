# GB Logix - server readiness check. Writes server-tools\specs.txt and opens it.
$out = New-Object System.Collections.Generic.List[string]
function Line($t) { $out.Add($t); Write-Host $t }
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$os = Get-CimInstance Win32_OperatingSystem
$bios = Get-CimInstance Win32_BIOS
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
$media = try { (Get-PhysicalDisk | Sort-Object DeviceId | Select-Object -First 1).MediaType } catch { 'Unknown' }
$battery = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue
$ram = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
$free = [math]::Round($disk.FreeSpace / 1GB, 0); $size = [math]::Round($disk.Size / 1GB, 0)
$node = try { (& node -v) 2>$null } catch { $null }
$up = (Get-Date) - $os.LastBootUpTime
$made = try { ([datetime]$bios.ReleaseDate).ToString('yyyy-MM') } catch { '?' }

Line "=== GB Logix server check  $(Get-Date -Format 'yyyy-MM-dd HH:mm') ==="
Line "PC:        $($cs.Manufacturer) $($cs.Model)  (BIOS $made)"
Line "Type:      $(if ($battery) { 'Laptop (has a battery)' } else { 'Desktop' })"
Line "Windows:   $($os.Caption) $($os.OSArchitecture)  build $($os.BuildNumber)"
Line "CPU:       $($cpu.Name.Trim())  - $($cpu.NumberOfCores) cores / $($cpu.NumberOfLogicalProcessors) threads"
Line "Memory:    $ram GB"
Line "Disk C:    $free GB free of $size GB  ($media)"
Line "Node.js:   $(if ($node) { $node } else { 'not installed' })"
Line "Running:   $([int]$up.TotalDays) days since last restart"
Line ""
Line "=== Verdict ==="
$ok = $true
function Check($good, $okish, $label, $msgGood, $msgOk, $msgBad) {
  if ($good) { Line "[OK]    $label - $msgGood" } elseif ($okish) { Line "[FAIR]  $label - $msgOk" } else { Line "[NO]    $label - $msgBad"; $script:ok = $false }
}
Check ($ram -ge 15) ($ram -ge 7.5) 'Memory' "$ram GB is plenty" "$ram GB works; close other programs" "$ram GB is too little (need 8 GB+)"
Check ($cpu.NumberOfCores -ge 4) ($cpu.NumberOfCores -ge 2) 'CPU' 'fast enough' 'works for a small team' 'too slow'
Check ($free -ge 100) ($free -ge 30) 'Disk space' "$free GB free" "$free GB free - fine for a year or two of PDFs" "$free GB free - free up space first"
Check ($media -eq 'SSD') ($media -ne 'HDD') 'Disk type' 'SSD' "$media" 'HDD (slow, wears out) - an SSD is much better'
Check ($os.Caption -match 'Windows (10|11)' -and $os.OSArchitecture -match '64') $false 'Windows' 'Windows 10/11 64-bit' '' 'needs Windows 10 or 11 (64-bit)'
if ($battery) {
  Line "[NOTE]  Laptop - keep it plugged in, lid open or set 'lid close = do nothing' (install-server does this), on a hard surface for cooling. Battery health:"
  try { $b = $battery | Select-Object -First 1; Line "        charge $($b.EstimatedChargeRemaining)%  status $($b.BatteryStatus)" } catch {}
}
Line ""
Line $(if ($ok) { 'RESULT: this PC can run the GB Logix server.' } else { 'RESULT: not recommended - see [NO] lines above.' })
$file = Join-Path $PSScriptRoot 'specs.txt'
$out | Set-Content -Encoding UTF8 $file
Start-Process notepad.exe $file
