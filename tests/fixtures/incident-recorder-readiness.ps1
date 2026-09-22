param([string]$FixtureRoot, [string]$SourceRoot, [string]$Scenario, [switch]$Installer)
$ErrorActionPreference = 'Stop'
$workerPath = Join-Path $FixtureRoot 'mock recorder.ps1'
$statusPath = Join-Path $FixtureRoot 'status.json'
$runner = (Get-Process -Id $PID).Path
$fixtureState = @{ process=$null; registered=$false; launchRequestedAt=$null }
$fixtureExitCode = 0
@'
param([string]$StatusPath, [string]$Scenario)
$ErrorActionPreference = 'Stop'
if ($Scenario -eq 'exit') { exit 7 }
if ($Scenario -eq 'missing') { Start-Sleep -Seconds 30; exit }
$state = @{pid=$PID; running=$true; lastSampleAt=[DateTime]::UtcNow.ToString('o'); samples=1}
switch ($Scenario) {
  'wrong-pid' { $state.pid = $PID + 1 }
  'not-running' { $state.running = $false }
  'string-running' { $state.running = 'true' }
  'stale' { $state.lastSampleAt = [DateTime]::UtcNow.AddDays(-1).ToString('o') }
  'future' { $state.lastSampleAt = [DateTime]::UtcNow.AddDays(1).ToString('o') }
  'invalid-time' { $state.lastSampleAt = 'invalid' }
  'no-sample' { $state.samples = 0 }
}
if ($Scenario -in @('partial','malformed')) {
  [IO.File]::WriteAllText($StatusPath, '{"running":')
  if ($Scenario -eq 'malformed') { Start-Sleep -Seconds 30; exit }
  Start-Sleep -Milliseconds 250
}
[IO.File]::WriteAllText($StatusPath, ($state | ConvertTo-Json -Compress))
Start-Sleep -Seconds 30
'@ | Set-Content -LiteralPath $workerPath -Encoding utf8

function Start-FixtureRecorder {
  $fixtureState.launchRequestedAt = [DateTimeOffset]::UtcNow
  $fixtureState.process = Start-Process -FilePath $runner -WindowStyle Hidden -PassThru -ArgumentList (
    '-NoLogo -NoProfile -NonInteractive -File "' + $workerPath + '" -StatusPath "' + $statusPath + '" -Scenario ' + $Scenario)
}
try {
  if ($Installer) {
    # Registry and WMI commands are intercepted before invoking the actual installer.
    # Only the mock writer is launched, and every real filesystem write stays under FixtureRoot.
    $env:USERPROFILE = $FixtureRoot
    $installedRoot = Join-Path $FixtureRoot '.codex-chatgpt-web\diagnostics\incident-recorder'
    $statusPath = Join-Path $installedRoot 'status.json'
    function Test-Path {
      param([string]$LiteralPath)
      if ($LiteralPath.StartsWith('HKCU:')) { return $true }
      Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath
    }
    function Get-ItemProperty { param($LiteralPath) return [pscustomobject]@{ CodexBridgeIncidentRecorder=$null } }
    function New-ItemProperty { param($LiteralPath,$Name,$Value,$PropertyType,[switch]$Force) $fixtureState.registered = $true }
    function New-CimInstance { param($ClassName,[switch]$ClientOnly,$Property) return @{} }
    function Invoke-CimMethod {
      param($ClassName,$MethodName,$Arguments)
      if ($Scenario -eq 'wmi-failure') { return [pscustomobject]@{ ReturnValue=5; ProcessId=0 } }
      Start-FixtureRecorder
      return [pscustomobject]@{ ReturnValue=0; ProcessId=$fixtureState.process.Id }
    }
    $timeout = if ($Scenario -in @('ready','partial')) { 10 } else { 2 }
    $result = & (Join-Path $SourceRoot 'scripts/install-codex-incident-recorder.ps1') -StartupTimeoutSeconds $timeout
    $receipt = Get-Content -LiteralPath (Join-Path $installedRoot 'install-receipt.json') -Raw | ConvertFrom-Json
    if (!$fixtureState.registered -or !(Test-Path -LiteralPath (Join-Path $installedRoot 'codex-incident-recorder-readiness.ps1'))) {
      throw 'Installer did not register the fixture or copy the readiness helper.'
    }
    if ($receipt.recorderPid -ne $fixtureState.process.Id -or !$receipt.recorderStartedAt -or !$receipt.firstObservedSampleAt) {
      throw 'Installation receipt did not identify the verified process and sample.'
    }
    $result
  } else {
    . (Join-Path $SourceRoot 'scripts/codex-incident-recorder-readiness.ps1')
    if ($Scenario -eq 'predates') {
      # A real live PID from before the requested launch must never be accepted.
      Wait-CodexIncidentRecorderReady -StatusPath $statusPath -RecorderProcessId $PID -LaunchStartedAt ([DateTimeOffset]::UtcNow) -TimeoutMilliseconds 500
    } else {
      Start-FixtureRecorder
      # Wait for the mock's initial write outside the measured readiness deadline.
      $setup = [Diagnostics.Stopwatch]::StartNew()
      while (!(Test-Path -LiteralPath $statusPath) -and !$fixtureState.process.HasExited -and $setup.Elapsed.TotalSeconds -lt 10) {
        Start-Sleep -Milliseconds 20
      }
      $watch = [Diagnostics.Stopwatch]::StartNew()
      try {
        $ready = Wait-CodexIncidentRecorderReady -StatusPath $statusPath -RecorderProcessId $fixtureState.process.Id -LaunchStartedAt $fixtureState.launchRequestedAt -TimeoutMilliseconds 600 -PollMilliseconds 20
        $ready | ConvertTo-Json -Compress
      } finally { [Console]::Error.WriteLine("readinessElapsedMs=$($watch.ElapsedMilliseconds)") }
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  $fixtureExitCode = 1
} finally {
  # Only this harness's child is stopped. No real recorder or user registry entry is accessed.
  if ($fixtureState.process) {
    if (!$fixtureState.process.HasExited) { $fixtureState.process.Kill(); $fixtureState.process.WaitForExit() }
    $fixtureState.process.Dispose()
  }
}
exit $fixtureExitCode
