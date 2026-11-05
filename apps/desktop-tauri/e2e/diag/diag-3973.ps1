param([int]$AppPid, [string]$Out, [string]$Tag)
# DIAG #3973 (throwaway branch): process tree, CPU and thread stacks of a stalled app.
$ErrorActionPreference = 'Continue'
$cdb = 'C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$base = Join-Path $Out "diag-$AppPid-$Tag"
$all = Get-CimInstance Win32_Process
$set = @{}
$set[$AppPid] = $true
do {
  $added = $false
  foreach ($p in $all) {
    if ($set.ContainsKey([int]$p.ParentProcessId) -and -not $set.ContainsKey([int]$p.ProcessId)) {
      $set[[int]$p.ProcessId] = $true
      $added = $true
    }
  }
} while ($added)
$tree = $all | Where-Object { $set.ContainsKey([int]$_.ProcessId) }
$cpu1 = @{}
foreach ($p in $tree) { $q = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue; if ($q) { $cpu1[[int]$p.ProcessId] = $q.TotalProcessorTime.TotalMilliseconds } }
Start-Sleep -Seconds 3
$lines = @()
foreach ($p in $tree) {
  $q = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  $delta = if ($q -and $cpu1.ContainsKey([int]$p.ProcessId)) { [int]($q.TotalProcessorTime.TotalMilliseconds - $cpu1[[int]$p.ProcessId]) } else { -1 }
  $type = if ($p.CommandLine -match '--type=([a-z-]+)') { $Matches[1] } else { 'browser/app' }
  $lines += "pid=$($p.ProcessId) ppid=$($p.ParentProcessId) name=$($p.Name) type=$type cpu3s_ms=$delta threads=$($q.Threads.Count)"
}
$lines += "--- system cpu"
$lines += (Get-CimInstance Win32_Processor | ForEach-Object { "load=$($_.LoadPercentage)" })
$lines | Set-Content "$base-tree.txt"
if (-not (Test-Path $cdb)) { "no cdb at $cdb" | Add-Content "$base-tree.txt"; exit 0 }
$exeDir = Split-Path -Parent $env:MEMRY_E2E_BINARY
$sym = "srv*C:\sym*https://msdl.microsoft.com/download/symbols;$exeDir"
# The app first, then renderers, browser, gpu, the rest.
$order = @($AppPid) + @($tree | Where-Object { $_.CommandLine -match '--type=renderer' } | ForEach-Object { [int]$_.ProcessId }) + @($tree | Where-Object { $_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { [int]$_.ProcessId }) + @($tree | Where-Object { $_.CommandLine -match '--type=gpu-process' } | ForEach-Object { [int]$_.ProcessId })
foreach ($id in ($order | Select-Object -Unique)) {
  $file = "$base-stacks-$id.txt"
  $proc = Start-Process -FilePath $cdb -ArgumentList @('-pv', '-p', "$id", '-y', "`"$sym`"", '-c', '"~*kn 60; q"') -NoNewWindow -PassThru -RedirectStandardOutput $file -RedirectStandardError "$file.err"
  if (-not $proc.WaitForExit(240000)) { $proc.Kill(); "cdb timed out" | Add-Content $file }
}
"done" | Add-Content "$base-tree.txt"
