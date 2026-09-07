param(
    [switch]$Cli,
    [string]$CodexPath,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$CodexArguments
)
$ErrorActionPreference = 'Stop'
$webCoreHome = if ($env:CODEX_CHATGPT_WEB_HOME) { $env:CODEX_CHATGPT_WEB_HOME } else { Join-Path $env:USERPROFILE '.codex-chatgpt-web' }
$webCodexHome = Join-Path $webCoreHome 'codex-home'
if (-not (Test-Path -LiteralPath (Join-Path $webCodexHome 'config.toml'))) { throw 'Web Codex home is not initialized.' }
$priorCodexHome = $env:CODEX_HOME
$priorDesktopData = $env:CODEX_ELECTRON_USER_DATA_PATH
try {
    $env:CODEX_HOME = $webCodexHome
    if ($Cli) {
        if (-not $CodexPath) { $CodexPath = (Get-Command codex -ErrorAction Stop).Source }
        & $CodexPath @CodexArguments
        if ($LASTEXITCODE -ne 0) { throw "Codex exited $LASTEXITCODE" }
    } else {
        if (-not $CodexPath) {
            $codexPackage = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
            if (-not $codexPackage) { throw 'Specify -CodexPath with the Codex Desktop executable.' }
            $CodexPath = Join-Path $codexPackage.InstallLocation 'app/ChatGPT.exe'
        }
        $env:CODEX_ELECTRON_USER_DATA_PATH = Join-Path $webCoreHome 'desktop'
        Start-Process -FilePath $CodexPath -ArgumentList @("--user-data-dir=`"$env:CODEX_ELECTRON_USER_DATA_PATH`"") -WindowStyle Hidden | Out-Null
    }
} finally {
    $env:CODEX_HOME = $priorCodexHome
    $env:CODEX_ELECTRON_USER_DATA_PATH = $priorDesktopData
}