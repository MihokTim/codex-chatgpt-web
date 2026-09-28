[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$OrcaArguments)
$ErrorActionPreference = 'Stop'
# A selected command must resolve; never switch silently to another Orca build.
if ($env:ORCA_CLI_COMMAND) {
    $orcaExecutable = (Get-Command -Name $env:ORCA_CLI_COMMAND -ErrorAction Stop).Source
} elseif ($env:ORCA_DEV_REPO_ROOT) {
    $orcaExecutable = (Get-Command -Name 'orca-dev' -ErrorAction Stop).Source
} else {
    $orcaExecutable = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\orca\resources\bin\orca.exe'))
    Get-Item -LiteralPath $orcaExecutable -ErrorAction Stop | Out-Null
}
& $orcaExecutable @OrcaArguments
exit $LASTEXITCODE
