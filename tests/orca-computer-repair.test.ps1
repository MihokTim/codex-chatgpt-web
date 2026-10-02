param([Parameter(Mandatory=$true)][string]$RuntimePath)
$ErrorActionPreference='Stop'
$tokens=$null; $parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile([IO.Path]::GetFullPath($RuntimePath),[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
# Evaluate only these definitions; no provider startup or desktop capture.
$names=@('Get-OrcaScreenshot','New-OrcaScreenshotFocusError')
foreach ($name in $names) {
    $node=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
    if ($null -eq $node) { throw "Missing $name" }
    Invoke-Expression $node.Extent.Text
}
function Test-OrcaWindowFocused { param([IntPtr]$WindowHandle) $false }
$frame=[pscustomobject]@{x=0;y=0;width=200;height=100}
$result=Get-OrcaScreenshot $true $frame ([IntPtr]123)
if ($null -ne $result.base64 -or $result.error.message -notmatch 'not foreground') { throw 'Background capture must return explicit error and no pixels' }
if ($null -ne (Get-OrcaScreenshot $false $frame ([IntPtr]123))) { throw 'No-screenshot must remain skipped' }
if ($null -ne (Get-OrcaScreenshot $true $null ([IntPtr]123))) { throw 'Missing frame must not capture' }
'PASS: PowerShell parse, unfocused capture refusal, skipped/missing frame'
# Stub the native dependencies to inspect the actual chord passed to SendKeys,
# without sending keyboard input from a unit test.
Add-Type -TypeDefinition 'using System;public static class OrcaDesktopWin32 {public static bool SetForegroundWindow(IntPtr h){return true;}}'
function Save-TestSentKeys { param([string]$Keys) $script:sentKeys=$Keys }
foreach ($name in @('ConvertTo-OrcaSendKeysModifier','ConvertTo-OrcaSendKeysKey','ConvertTo-OrcaSendKeysText','Send-OrcaHotkey')) {
    $node=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
    $definition=$node.Extent.Text.Replace('[System.Windows.Forms.SendKeys]::SendWait(', 'Save-TestSentKeys (')
    Invoke-Expression $definition
}
Send-OrcaHotkey ([IntPtr]123) 'CmdOrCtrl+A'
if ($script:sentKeys -cne '^a') { throw 'Physical uppercase A must not imply Shift' }
Send-OrcaHotkey ([IntPtr]123) 'CmdOrCtrl+Shift+A'
if ($script:sentKeys -cne '^+a') { throw 'Explicit Shift must be preserved' }
'PASS: uppercase physical hotkey and explicit Shift chord'
