function Wait-CodexIncidentRecorderReady {
  param(
    [Parameter(Mandatory)][string]$StatusPath,
    [Parameter(Mandatory)][ValidateRange(1,2147483647)][int]$RecorderProcessId,
    [Parameter(Mandatory)][DateTimeOffset]$LaunchStartedAt,
    [ValidateRange(1,120000)][int]$TimeoutMilliseconds = 30000,
    [ValidateRange(1,1000)][int]$PollMilliseconds = 100
  )
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $processStartedAt = $null
  $lastReason = 'status file has not been written'
  while ($timer.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
    # Compare the actual creation time on every poll: a reused PID is not this launch.
    $process = Get-Process -Id $RecorderProcessId -ErrorAction SilentlyContinue
    if (!$process) { throw "Recorder process $RecorderProcessId exited before a running status was confirmed." }
    try { $observedStart = $process.StartTime.ToUniversalTime() }
    catch { throw "Recorder process $RecorderProcessId start time could not be verified: $($_.Exception.Message)" }
    finally { $process.Dispose() }
    if ($observedStart -lt $LaunchStartedAt.UtcDateTime) {
      throw "Recorder process $RecorderProcessId predates this launch; refusing a stale or unrelated PID."
    }
    if ($null -eq $processStartedAt) { $processStartedAt = $observedStart }
    elseif ($observedStart -ne $processStartedAt) { throw "Recorder process $RecorderProcessId was replaced before readiness." }

    $state = $null
    try {
      if (Test-Path -LiteralPath $StatusPath) {
        # The recorder writes in place; a partial JSON document is retried within the same deadline.
        $state = Get-Content -LiteralPath $StatusPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
      }
    } catch { $lastReason = 'status file is unreadable or incomplete JSON' }
    if ($null -ne $state) {
      $sampleAt = [DateTimeOffset]::MinValue
      # PowerShell 7.5+ decodes ISO JSON dates to DateTime; older versions leave strings.
      $validTime = if ($state.lastSampleAt -is [DateTime] -or $state.lastSampleAt -is [DateTimeOffset]) {
        $sampleAt = [DateTimeOffset]$state.lastSampleAt
        $true
      } else {
        [DateTimeOffset]::TryParse([string]$state.lastSampleAt, [Globalization.CultureInfo]::InvariantCulture,
          [Globalization.DateTimeStyles]::None, [ref]$sampleAt)
      }
      if (($state.pid -isnot [long] -and $state.pid -isnot [int]) -or $state.pid -ne $RecorderProcessId) {
        $lastReason = 'status PID does not match the launched process'
      } elseif ($state.running -isnot [bool] -or !$state.running) {
        $lastReason = 'status is not running=true'
      } elseif (!$validTime -or $sampleAt.UtcDateTime -lt $processStartedAt -or $sampleAt -gt [DateTimeOffset]::UtcNow) {
        $lastReason = 'status sample timestamp is invalid or does not belong to this process start'
      } elseif (($state.samples -isnot [long] -and $state.samples -isnot [int]) -or $state.samples -lt 1) {
        $lastReason = 'status has no completed sample'
      } else {
        # Recheck after reading the file so a stopped/replaced process cannot authenticate stale status.
        $current = Get-Process -Id $RecorderProcessId -ErrorAction SilentlyContinue
        if (!$current) { throw "Recorder process $RecorderProcessId exited while confirming its status." }
        try {
          if ($current.StartTime.ToUniversalTime() -ne $processStartedAt -or $current.HasExited) {
            throw "Recorder process $RecorderProcessId exited or was replaced while confirming its status."
          }
        } finally { $current.Dispose() }
        if ($timer.ElapsedMilliseconds -ge $TimeoutMilliseconds) {
          $lastReason = 'matching status arrived after the readiness deadline'
          break
        }
        return [pscustomobject]@{
          pid=$RecorderProcessId
          processStartedAt=$processStartedAt.ToString('o')
          firstObservedSampleAt=$sampleAt.ToUniversalTime().ToString('o')
        }
      }
    }
    $remaining = $TimeoutMilliseconds - $timer.ElapsedMilliseconds
    if ($remaining -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Min($PollMilliseconds, $remaining)) }
  }
  throw "Recorder process $RecorderProcessId readiness timed out after ${TimeoutMilliseconds}ms: $lastReason. Status: $StatusPath"
}
