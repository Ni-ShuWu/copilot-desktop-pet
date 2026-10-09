# 桌宠启动脚本：双击 start-pet.bat，或运行 powershell -File start-pet.ps1
# 逻辑：已在运行 → 提示退出；有 Copilot 会话加载了扩展 → 让该实例召唤（联动会话状态）；否则独立模式启动
$ErrorActionPreference = 'SilentlyContinue'
$here = $PSScriptRoot

function Test-PetWindowVisible {
    if (-not ('PetLauncher.Win' -as [type])) {
        Add-Type -Namespace PetLauncher -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
'@
    }
    $script:petFound = $false
    $cb = [PetLauncher.Win+EnumWindowsProc] {
        param([IntPtr]$h, [IntPtr]$l)
        if ([PetLauncher.Win]::IsWindowVisible($h)) {
            $ownerPid = 0
            [void][PetLauncher.Win]::GetWindowThreadProcessId($h, [ref]$ownerPid)
            $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -eq 'powershell') {
                $cls = New-Object System.Text.StringBuilder 512
                [void][PetLauncher.Win]::GetClassName($h, $cls, 512)
                $title = New-Object System.Text.StringBuilder 512
                [void][PetLauncher.Win]::GetWindowText($h, $title, 512)
                # Settings/chat windows share the WPF class but are not the pet.
                if ($cls.ToString().StartsWith('HwndWrapper[DefaultDomain;Pipeline Execution Thread;') -and ($title.Length -eq 0 -or $title.ToString() -eq 'Copilot Desktop Pet')) { $script:petFound = $true }
            }
        }
        return $true
    }
    [void][PetLauncher.Win]::EnumWindows($cb, [IntPtr]::Zero)
    return $script:petFound
}

function Get-LiveExtensionPorts {
    $dir = Join-Path $env:TEMP 'copilot-desktop-pet'
    $portOf = @{}
    netstat -ano | Select-String 'LISTENING' | ForEach-Object {
        $parts = $_.Line.Trim() -split '\s+'
        $pid2 = [int]$parts[-1]
        if (-not $portOf.ContainsKey($pid2)) { $portOf[$pid2] = @() }
        $portOf[$pid2] += [int](($parts[1] -split ':')[-1])
    }
    $out = @()
    Get-ChildItem $dir -Filter 'inst-*.json' -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            $j = Get-Content -Raw $_.FullName | ConvertFrom-Json
            if (Get-Process -Id ([int]$j.pid) -ErrorAction SilentlyContinue) {
                if ($portOf.ContainsKey([int]$j.pid)) { $out += $portOf[[int]$j.pid] }
            }
        } catch {}
    }
    return ($out | Select-Object -Unique)
}

if (Test-PetWindowVisible) {
    Write-Host '桌宠已经在桌面上了，不用重复召唤。' -ForegroundColor Yellow
    exit 0
}

foreach ($port in Get-LiveExtensionPorts) {
    try {
        $state = Invoke-RestMethod "http://127.0.0.1:$port/api/state" -TimeoutSec 2
        if ($state.running) {
            Write-Host '桌宠已经在桌面上了，不用重复召唤。' -ForegroundColor Yellow
            exit 0
        }
    } catch {}
    try {
        $r = Invoke-RestMethod "http://127.0.0.1:$port/api/pet/show" -Method Post -TimeoutSec 5
        if ($r.ok) {
            Write-Host "桌宠已召唤（扩展实例联动模式，pid $($r.pid)）。" -ForegroundColor Green
            exit 0
        }
    } catch {}
}

$win = Join-Path $here 'pet-window.ps1'
if (-not (Test-Path $win)) {
    Write-Host "找不到 pet-window.ps1（期望位置：$win）" -ForegroundColor Red
    exit 1
}
Start-Process powershell -WindowStyle Hidden -ArgumentList ('-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $win + '"')
Write-Host '桌宠已召唤（独立模式：检测 Copilot App 运行并读取会话事件联动状态）。' -ForegroundColor Green
exit 0
