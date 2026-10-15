param([int]$ProcessId, [int]$Seconds = 12, [int]$IntervalMs = 100)
$ErrorActionPreference = 'Stop'
if (-not ("PetProbe" -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PetProbe
{
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    private delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    public static IntPtr Find(uint pid)
    {
        IntPtr found = IntPtr.Zero;
        EnumProc cb = delegate(IntPtr h, IntPtr l)
        {
            uint owner; GetWindowThreadProcessId(h, out owner);
            if (owner == pid && IsWindowVisible(h)) { found = h; return false; }
            return true;
        };
        EnumWindows(cb, IntPtr.Zero);
        GC.KeepAlive(cb);
        return found;
    }
    public static int[] Bounds(IntPtr h)
    {
        RECT r;
        if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0)
        { if (!GetWindowRect(h, out r)) return null; }
        return new int[] { r.Left, r.Top, r.Right, r.Bottom };
    }
}
'@
}
$handle = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds(15)
while ($handle -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 100
    $handle = [PetProbe]::Find([uint32]$ProcessId)
}
if ($handle -eq [IntPtr]::Zero) { Write-Output "PROBE_ERROR no window for pid $ProcessId"; exit 2 }
$samples = New-Object System.Collections.ArrayList
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
    $b = [PetProbe]::Bounds($handle)
    if ($null -ne $b) { [void]$samples.Add(@($b[0], $b[1])) }
    Start-Sleep -Milliseconds $IntervalMs
}
$json = ($samples | ForEach-Object { "[" + $_[0] + "," + $_[1] + "]" }) -join ","
Write-Output ("SAMPLES=[" + $json + "]")
