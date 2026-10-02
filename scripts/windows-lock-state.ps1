# Read-only check immediately before an authorized GUI acceptance batch.
# SessionFlags contract: https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class CodexGuiLockState {
 [DllImport("wtsapi32.dll",SetLastError=true)] public static extern bool WTSQuerySessionInformation(IntPtr server,int session,int info,out IntPtr buffer,out int bytes);
 [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr buffer);
}
'@
$buffer=[IntPtr]::Zero; $bytes=0; $state='UNKNOWN'; $flags=$null
$sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId
try {
    if ([Environment]::OSVersion.Version.Major -ge 10 -and
        [CodexGuiLockState]::WTSQuerySessionInformation([IntPtr]::Zero,$sessionId,25,[ref]$buffer,[ref]$bytes) -and
        $bytes -ge 20 -and [Runtime.InteropServices.Marshal]::ReadInt32($buffer,0) -eq 1 -and
        [Runtime.InteropServices.Marshal]::ReadInt32($buffer,8) -eq $sessionId) {
        $flags=[Runtime.InteropServices.Marshal]::ReadInt32($buffer,16)
        if ($flags -eq 0) { $state='LOCKED' } elseif ($flags -eq 1) { $state='UNLOCKED' }
    }
} finally {
    if ($buffer -ne [IntPtr]::Zero) { [CodexGuiLockState]::WTSFreeMemory($buffer) }
}
@{state=$state;flags=$flags;sessionId=$sessionId;at=[DateTime]::UtcNow.ToString('o');source='WTSInfoEx SessionFlags'} | ConvertTo-Json
