param([int]$AppPid, [string]$Out, [string]$Tag, [string]$Match)
# DIAG #3973 (throwaway branch): process tree, CPU and thread stacks of a stalled app.
$ErrorActionPreference = 'Continue'
$cdb = 'C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$base = Join-Path $Out "diag-$AppPid-$Tag"
$all = Get-CimInstance Win32_Process
# WebView2's processes are not our children; they carry the profile's user-data-dir.
$tree = @($all | Where-Object { $_.ProcessId -eq $AppPid -or ($_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -and $_.CommandLine.Contains($Match)) })
$cpu1 = @{}
foreach ($p in $tree) { $q = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue; if ($q) { $cpu1[[int]$p.ProcessId] = $q.TotalProcessorTime.TotalMilliseconds } }
Start-Sleep -Milliseconds 1000
$lines = @()
foreach ($p in $tree) {
  $q = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  $delta = if ($q -and $cpu1.ContainsKey([int]$p.ProcessId)) { [int]($q.TotalProcessorTime.TotalMilliseconds - $cpu1[[int]$p.ProcessId]) } else { -1 }
  $type = if ($p.CommandLine -match '--type=([a-z-]+)') { $Matches[1] } else { if ($p.ProcessId -eq $AppPid) { 'app' } else { 'browser' } }
  $lines += "pid=$($p.ProcessId) ppid=$($p.ParentProcessId) type=$type cpu1s_ms=$delta threads=$($q.Threads.Count)"
}
$lines += (Get-CimInstance Win32_Processor | ForEach-Object { "system load=$($_.LoadPercentage)" })
$lines | Set-Content "$base-tree.txt"
if (-not (Test-Path $cdb)) { "no cdb at $cdb" | Add-Content "$base-tree.txt"; exit 0 }
$exeDir = Split-Path -Parent $env:MEMRY_E2E_BINARY
$sym = "srv*C:\sym*https://msdl.microsoft.com/download/symbols;$exeDir"
$byType = { param($t) @($tree | Where-Object { $_.CommandLine -match "--type=$t" } | ForEach-Object { [int]$_.ProcessId }) }
$browser = @($tree | Where-Object { $_.ProcessId -ne $AppPid -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { [int]$_.ProcessId })
$order = (& $byType 'renderer') + @($AppPid) + $browser + (& $byType 'gpu-process')
foreach ($id in ($order | Select-Object -Unique)) {
  $file = "$base-stacks-$id.txt"
  # Invasive attach; `qd` detaches and leaves the process running.
  $proc = Start-Process -FilePath $cdb -ArgumentList @('-p', "$id", '-y', "`"$sym`"", '-c', '"~*kn 60; qd"') -NoNewWindow -PassThru -RedirectStandardOutput $file -RedirectStandardError "$file.err"
  if (-not $proc.WaitForExit(300000)) { $proc.Kill(); "cdb timed out" | Add-Content $file }
}
"done" | Add-Content "$base-tree.txt"
