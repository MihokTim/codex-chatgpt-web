param(
  [string]$OutputDirectory = (Join-Path $env:USERPROFILE '.codex-chatgpt-web\diagnostics\incident-recorder'),
  [string]$BunPath = (Join-Path $env:USERPROFILE '.codex-chatgpt-web\versions\5.0.8-win32-x64\runtime\bun.exe'),
  [string]$CollectorPath = (Join-Path $PSScriptRoot 'collect-codex-incident.ts'),
  [string]$IncidentDirectory = (Join-Path $env:USERPROFILE '.codex-chatgpt-web\diagnostics\incidents'),
  [string[]]$CrashDirectories = @(),
  [string]$LauncherLogPath = (Join-Path $env:APPDATA 'Codex Web GPT\logs\launcher.jsonl'),
  [ValidateRange(1,60)][int]$IntervalSeconds = 5,
  [ValidateRange(0,1000000)][int]$MaxSamples = 0,
  [switch]$Stop
)
$ErrorActionPreference = 'Stop'
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$null = New-Item -ItemType Directory -Path $OutputDirectory -Force
$stopPath = Join-Path $OutputDirectory 'stop.request'
if ($Stop) { [IO.File]::WriteAllText($stopPath, [DateTime]::UtcNow.ToString('o')); return }
# FileShare.None provides a per-output-directory singleton without relying on reusable PIDs.
try { $lock = [IO.File]::Open((Join-Path $OutputDirectory 'recorder.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
catch { throw 'An incident recorder already holds this output directory.' }
if (Test-Path -LiteralPath $stopPath) { Remove-Item -LiteralPath $stopPath }
$utf8 = New-Object Text.UTF8Encoding($false)
$samplePath = Join-Path $OutputDirectory 'samples.jsonl'
$statePath = Join-Path $OutputDirectory 'status.json'
function Write-Record($value) {
  if ((Test-Path -LiteralPath $samplePath) -and (Get-Item -LiteralPath $samplePath).Length -ge 5MB) {
    $oldest = "$samplePath.3"
    if (Test-Path -LiteralPath $oldest) { Remove-Item -LiteralPath $oldest }
    for ($number = 2; $number -ge 1; $number--) {
      $source = "$samplePath.$number"
      if (Test-Path -LiteralPath $source) { Move-Item -LiteralPath $source -Destination "$samplePath.$($number + 1)" }
    }
    Move-Item -LiteralPath $samplePath -Destination "$samplePath.1"
  }
  [IO.File]::AppendAllText($samplePath, (($value | ConvertTo-Json -Depth 8 -Compress) + "`n"), $utf8)
}
$crashRoots = @((Join-Path $env:APPDATA 'Codex\web\Codex\Crashpad\reports'))
$packagesPath = Join-Path $env:LOCALAPPDATA 'Packages'
if (Test-Path -LiteralPath $packagesPath) {
  foreach ($package in Get-ChildItem -LiteralPath $packagesPath -Directory -Filter 'OpenAI.Codex_*') {
    $crashRoots += Join-Path $package.FullName 'LocalCache\Roaming\Codex\web\Codex\Crashpad\reports'
  }
}
if ($CrashDirectories.Count -gt 0) { $crashRoots = $CrashDirectories }
function Crash-Files {
  foreach ($root in $crashRoots) {
    if (Test-Path -LiteralPath $root) {
      Get-ChildItem -LiteralPath $root -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 50
    }
  }
}
$knownCrashes = @{}
foreach ($file in Crash-Files) { $knownCrashes[$file.FullName] = $true }
$previous = @{}
$roles = @{}
$lastCapture = [DateTime]::MinValue
$count = 0
$systemMemory = $null
$launcherOffset = if (Test-Path -LiteralPath $LauncherLogPath) { (Get-Item -LiteralPath $LauncherLogPath).Length } else { 0L }
$pendingCapture = $false
function New-BridgeFailures {
  if (!(Test-Path -LiteralPath $LauncherLogPath)) { return }
  $stream = [IO.File]::Open($LauncherLogPath, 'Open', 'Read', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  try {
    if ($script:launcherOffset -gt $stream.Length) { $script:launcherOffset = 0L }
    $start = [Math]::Max($script:launcherOffset, $stream.Length - 131072)
    $null = $stream.Seek($start, 'Begin')
    $buffer = New-Object byte[] ([int]($stream.Length - $start))
    $read = $stream.Read($buffer, 0, $buffer.Length)
    $lastNewline = $read - 1
    while ($lastNewline -ge 0 -and $buffer[$lastNewline] -ne 10) { $lastNewline-- }
    if ($lastNewline -lt 0) { return }
    $text = [Text.Encoding]::UTF8.GetString($buffer, 0, $lastNewline + 1)
    $script:launcherOffset = $start + $lastNewline + 1
    foreach ($line in ($text -split "`n")) {
      try {
        $record = $line | ConvertFrom-Json
        $message = [string]$record.detail.line
        $position = $message.IndexOf('http_turn {')
        if ($position -lt 0) { continue }
        $event = $message.Substring($position + 'http_turn '.Length) | ConvertFrom-Json
        # Native passthrough can abort a completed tool round normally. Only capture an unfinished
        # routed Web turn's client abort; an abort signal alone never establishes a fault.
        if (($event.phase -eq 'sse_terminal' -and $event.sseTerminal -in @('failed','incomplete')) -or ($event.phase -eq 'client_abort_signal' -and $event.traceId -and $event.sseTerminal -ne 'completed') -or ($event.phase -eq 'end' -and $event.reason -in @('source_error','request_error'))) {
          @{ at=$event.at; phase=$event.phase; traceId=$event.traceId; threadId=$event.threadId; turnId=$event.turnId; httpTurnId=$event.httpTurnId; errorCode=$event.errorCode; sseTerminal=$event.sseTerminal }
        }
      } catch { }
    }
  } finally { $stream.Dispose() }
}
try {
  Write-Record @{ at=[DateTime]::UtcNow.ToString('o'); kind='recorder_started'; pid=$PID; intervalSeconds=$IntervalSeconds }
  while (!(Test-Path -LiteralPath $stopPath) -and ($MaxSamples -eq 0 -or $count -lt $MaxSamples)) {
    $now = [DateTime]::UtcNow
    $current = @{}
    $processes = @()
    # The MSIX Codex desktop executable is currently named ChatGPT.exe; codex.exe is native CLI.
    foreach ($process in @(Get-Process -Name Codex,ChatGPT -ErrorAction SilentlyContinue)) {
      try {
        if ($process.ProcessName -eq 'ChatGPT' -and $process.Path -notmatch '\\WindowsApps\\OpenAI.Codex_') { continue }
        $key = "$($process.Id):$($process.StartTime.ToUniversalTime().Ticks)"
        if (!$roles.ContainsKey($key)) {
          $path = $process.Path
          $role = if ($path -match '\\WindowsApps\\OpenAI.Codex_') { 'desktop' } else { 'native' }
          $details = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)" -ErrorAction SilentlyContinue
          if ($role -eq 'desktop' -and $details.CommandLine -match '--type=([a-z-]+)') { $role = "desktop_$($Matches[1])" }
          $roles[$key] = $role
        }
        $entry = @{ pid=$process.Id; role=$roles[$key]; startedAt=$process.StartTime.ToUniversalTime().ToString('o'); privateBytes=$process.PrivateMemorySize64; peakPagedBytes=$process.PeakPagedMemorySize64; workingSetBytes=$process.WorkingSet64; peakWorkingSetBytes=$process.PeakWorkingSet64; cpuSeconds=$process.TotalProcessorTime.TotalSeconds; handles=$process.HandleCount }
        $current[$key] = $entry
        $processes += $entry
      } catch { }
    }
    $exited = @($previous.Keys | Where-Object { !$current.ContainsKey($_) } | ForEach-Object { $previous[$_] })
    foreach ($key in @($roles.Keys)) { if (!$current.ContainsKey($key)) { $roles.Remove($key) } }
    if (($count % 6) -eq 0) {
      try { $os = Get-CimInstance Win32_OperatingSystem; $systemMemory = @{ totalPhysicalKB=$os.TotalVisibleMemorySize; freePhysicalKB=$os.FreePhysicalMemory; totalVirtualKB=$os.TotalVirtualMemorySize; freeVirtualKB=$os.FreeVirtualMemory } } catch { }
    }
    $health = @{ reachable=$false }
    try {
      $h = Invoke-RestMethod -Uri 'http://127.0.0.1:17841/healthz' -TimeoutSec 2
      $health = @{ reachable=$true; pid=$h.pid; activeHttp=$h.active_http_turns; activeBrowser=$h.active_browser_turns; accepting=$h.accepting_turns }
    } catch { }
    $newCrashes = @()
    foreach ($file in Crash-Files) {
      if (!$knownCrashes.ContainsKey($file.FullName)) { $newCrashes += @{ name=$file.Name; bytes=$file.Length; modifiedAt=$file.LastWriteTimeUtc.ToString('o') }; $knownCrashes[$file.FullName] = $true }
    }
    $bridgeFailures = @()
    try { $bridgeFailures = @(New-BridgeFailures) } catch { Write-Record @{ at=$now.ToString('o'); kind='launcher_log_read_failed'; errorType=$_.Exception.GetType().Name } }
    Write-Record @{ at=$now.ToString('o'); kind='sample'; processes=$processes; exited=$exited; systemMemory=$systemMemory; bridge=$health; newCrashFiles=$newCrashes; bridgeFailures=$bridgeFailures }
    if ($newCrashes.Count -gt 0 -or $bridgeFailures.Count -gt 0 -or @($exited | Where-Object { $_.role -eq 'desktop' }).Count -gt 0) { $pendingCapture = $true }
    if ($pendingCapture -and ($now - $lastCapture).TotalSeconds -ge 60) {
      $lastCapture = $now
      $pendingCapture = $false
      try {
        $captureOutput = & $BunPath $CollectorPath $IncidentDirectory 2>&1
        $captureCode = $LASTEXITCODE
        $bundlePath = [string]($captureOutput | Select-Object -Last 1)
        if ($captureCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $bundlePath 'manifest.json'))) {
          $eventRows = @()
          $eventStatus = 'queried'
          try {
            $events = @(Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000,1001,1002; StartTime=(Get-Date).AddMinutes(-15)} -MaxEvents 30 -ErrorAction SilentlyContinue)
            foreach ($event in $events) {
              $xml = [xml]$event.ToXml()
              $data = @{}
              foreach ($entry in $xml.Event.EventData.Data) {
                if ([string]$entry.Name -match '^(AppName|AppVersion|ModuleName|ModuleVersion|ExceptionCode|FaultingOffset|ProcessId|ProcessCreationTime|HangType|ReportId)$') { $data[[string]$entry.Name] = [string]$entry.'#text' }
              }
              if ($data.AppName -match '^(ChatGPT|Codex|codex)\.exe$') { $eventRows += @{at=$event.TimeCreated.ToUniversalTime().ToString('o'); eventId=$event.Id; data=$data} }
            }
          } catch { $eventStatus = $_.Exception.GetType().Name }
          [IO.File]::WriteAllText((Join-Path $bundlePath 'windows-events.json'), (@{status=$eventStatus; records=$eventRows} | ConvertTo-Json -Depth 8), $utf8)
        }
        Write-Record @{ at=[DateTime]::UtcNow.ToString('o'); kind='incident_collected'; exitCode=$captureCode; output=$bundlePath }
      } catch { Write-Record @{ at=[DateTime]::UtcNow.ToString('o'); kind='collection_failed'; errorType=$_.Exception.GetType().Name } }
    }
    $count++
    [IO.File]::WriteAllText($statePath, (@{ running=$true; pid=$PID; lastSampleAt=$now.ToString('o'); samples=$count; outputDirectory=$OutputDirectory } | ConvertTo-Json -Compress), $utf8)
    $previous = $current
    if ($MaxSamples -eq 0 -or $count -lt $MaxSamples) { Start-Sleep -Seconds $IntervalSeconds }
  }
} finally {
  Write-Record @{ at=[DateTime]::UtcNow.ToString('o'); kind='recorder_stopped'; pid=$PID }
  [IO.File]::WriteAllText($statePath, (@{ running=$false; pid=$PID; stoppedAt=[DateTime]::UtcNow.ToString('o'); samples=$count } | ConvertTo-Json -Compress), $utf8)
  $lock.Dispose()
}
