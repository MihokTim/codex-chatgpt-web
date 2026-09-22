param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:USERPROFILE '.codex-chatgpt-web\diagnostics\incident-recorder'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'CodexBridgeIncidentRecorder'
$scriptPath = Join-Path $root 'codex-incident-recorder.ps1'
if ($Uninstall) {
  if (Test-Path -LiteralPath $scriptPath) { & $scriptPath -Stop }
  $existing = (Get-ItemProperty -LiteralPath $runKey).PSObject.Properties[$runName].Value
  if ($existing -and !$existing.Contains($scriptPath)) { throw 'Unexpected startup entry; refusing removal.' }
  if ($existing) { Remove-ItemProperty -LiteralPath $runKey -Name $runName }
  Write-Output 'Stop requested; logon registration removed. Evidence retained.'
  return
}
$runner = (Get-Process -Id $PID).Path
if ([IO.Path]::GetFileName($runner) -ne 'pwsh.exe') { throw 'Run this installer using the configured PowerShell 7 runtime.' }
$null = New-Item -ItemType Directory -Path $root -Force
if (!(Test-Path -LiteralPath $runKey)) { $null = New-Item -Path $runKey }
$command = '"' + $runner + '" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "' + $scriptPath + '"'
$existing = (Get-ItemProperty -LiteralPath $runKey).PSObject.Properties[$runName].Value
if ($existing -and $existing -ne $command) { throw 'Startup entry already exists with a different command.' }
$statusPath = Join-Path $root 'status.json'
if (Test-Path -LiteralPath $statusPath) {
  $state = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
  if ($state.running -and (Get-Process -Id $state.pid -ErrorAction SilentlyContinue)) { throw 'Recorder already running; stop it before replacing its files.' }
}
foreach ($name in @('codex-incident-recorder.ps1','collect-codex-incident.ts','install-codex-incident-recorder.ps1')) {
  if ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot $name)) -ne [IO.Path]::GetFullPath((Join-Path $root $name))) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $root $name)
  }
}
$null = New-ItemProperty -LiteralPath $runKey -Name $runName -Value $command -PropertyType String -Force
$arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "' + $scriptPath + '"'
# A direct child of a Codex terminal inherits its Windows job and can disappear when
# Desktop exits. WMI launches the same user-owned helper outside that terminal job.
# The startup entry still handles the next Windows sign-in; no elevated service is used.
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow=[uint16]0 }
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine=('"' + $runner + '" ' + $arguments); ProcessStartupInformation=$startup
}
if ($created.ReturnValue -ne 0) { throw "Detached recorder launch failed: $($created.ReturnValue)" }
$receipt = @{ installedAt=[DateTime]::UtcNow.ToString('o'); recorderPid=$created.ProcessId; launchMode='wmi-detached-hidden'; runner=$runner; startupKey=$runKey; startupName=$runName; command=$command; intervalSeconds=5; sampleMaxBytes=20MB; incidentBundlesRetained=5 }
$receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'install-receipt.json') -Encoding utf8
$receipt | ConvertTo-Json -Compress
