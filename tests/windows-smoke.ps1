param([string]$RepoDir, [string]$TestDir)
$ErrorActionPreference = 'Stop'
$ExtDir = $RepoDir; $DataDir = Join-Path $TestDir 'data'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, UIAutomationClient, UIAutomationTypes
. (Join-Path $RepoDir 'pet-data.ps1')
function Assert-True($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
Initialize-PetData
$fpsConfig = [pscustomobject]@{ fps = 8; animations = [pscustomobject]@{ idle = [pscustomobject]@{ fps = 5 }; walk = [pscustomobject]@{ fps = 12 }; sleep = [pscustomobject]@{ fps = 2 }; thinking = [pscustomobject]@{} } }
Assert-True ((Get-PetAnimationFps $fpsConfig 'idle') -eq 5) 'Animation FPS must override the global FPS'
Assert-True ((Get-PetAnimationFps $fpsConfig 'walk') -eq 12) 'Each animation must support its own FPS'
Assert-True ((Get-PetAnimationFps $fpsConfig 'sleep') -eq 2) 'Slow animation FPS must be preserved'
Assert-True ((Get-PetAnimationFps $fpsConfig 'thinking') -eq 8) 'Animations without FPS must inherit the global FPS'
Assert-True ((Get-PetAnimationFps $fpsConfig 'missing') -eq 8) 'Missing animations must fall back to the global FPS'

# ---- 全向走动：纯函数（角度/朝向/位移与边界反射） ----
$pi = [Math]::PI
$tau = 2 * $pi
# 随机角度覆盖 0..2PI 且不越界
$headings = 1..2000 | ForEach-Object { Get-PetRandomHeading }
Assert-True (($headings | Measure-Object -Minimum).Minimum -ge 0) 'Random heading must not be negative'
Assert-True (($headings | Measure-Object -Maximum).Maximum -lt $tau) 'Random heading must stay below 2PI'
Assert-True (($headings | Measure-Object -Maximum).Maximum -gt ($tau * 0.99)) 'Random heading must reach the whole circle'
# 全向：四个象限都要走到（含上下与斜向，而不只是左右）
$quadrants = $headings | ForEach-Object { [Math]::Floor($_ / ($pi / 2)) } | Sort-Object -Unique
Assert-True ($quadrants.Count -eq 4) 'Random heading must cover all four quadrants'
# 朝向：偏右 -> 1、偏左 -> -1、纯上下 -> 0（保持原朝向）
Assert-True ((Get-PetFacing 0) -eq 1) 'Heading right must face right'
Assert-True ((Get-PetFacing ($pi / 4)) -eq 1) 'Heading down-right must face right'
Assert-True ((Get-PetFacing $pi) -eq -1) 'Heading left must face left'
Assert-True ((Get-PetFacing (3 * $pi / 4)) -eq -1) 'Heading down-left must face left'
Assert-True ((Get-PetFacing ($pi / 2)) -eq 0) 'Heading straight down must keep facing'
Assert-True ((Get-PetFacing (3 * $pi / 2)) -eq 0) 'Heading straight up must keep facing'
Assert-True ((Get-PetFacing ([double]::NaN)) -eq 0) 'NaN heading must keep facing'
# 直线前进：角度 0 只走 X、角度 PI/2 只走 Y
$s = Move-PetStep -X 100 -Y 100 -Angle 0 -Speed 40 -Seconds 0.5 -MinX 0 -MaxX 1000 -MinY 0 -MaxY 1000
Assert-True ([Math]::Abs($s.X - 120) -lt 1e-6) 'Angle 0 must move right by speed*dt'
Assert-True ([Math]::Abs($s.Y - 100) -lt 1e-6) 'Angle 0 must not change Y'
Assert-True ($s.Dir -eq 1 -and -not $s.Bounced) 'Angle 0 must face right without bouncing'
$s = Move-PetStep -X 100 -Y 100 -Angle ($pi / 2) -Speed 40 -Seconds 0.5 -MinX 0 -MaxX 1000 -MinY 0 -MaxY 1000
Assert-True ([Math]::Abs($s.X - 100) -lt 1e-6) 'Angle PI/2 must not change X'
Assert-True ([Math]::Abs($s.Y - 120) -lt 1e-6) 'Angle PI/2 must move down by speed*dt'
# 斜向：两个分量同时前进，且速度模长守恒
$s = Move-PetStep -X 100 -Y 100 -Angle ($pi / 4) -Speed 40 -Seconds 0.5 -MinX 0 -MaxX 1000 -MinY 0 -MaxY 1000
$dist = [Math]::Sqrt([Math]::Pow($s.X - 100, 2) + [Math]::Pow($s.Y - 100, 2))
Assert-True ([Math]::Abs($dist - 20) -lt 1e-6) 'Diagonal step must preserve the travel distance'
Assert-True ($s.X -gt 100 -and $s.Y -gt 100) 'Down-right diagonal must move on both axes'
# 左右反射：撞右墙后水平分量反向（角度 -> PI - 角度），垂直分量保持
$s = Move-PetStep -X 990 -Y 500 -Angle 0 -Speed 40 -Seconds 1 -MinX 0 -MaxX 1000 -MinY 0 -MaxY 1000
Assert-True ($s.Bounced) 'Hitting the right edge must report a bounce'
Assert-True ($s.X -eq 1000) 'Hitting the right edge must clamp X to MaxX'
Assert-True ([Math]::Abs($s.Angle - $pi) -lt 1e-9) 'Right bounce must flip the heading to PI'
Assert-True ($s.Dir -eq -1) 'Right bounce must face left'
# 上下反射：撞下墙后垂直分量反向（角度取负），水平分量保持
$s = Move-PetStep -X 500 -Y 990 -Angle ($pi / 2) -Speed 40 -Seconds 1 -MinX 0 -MaxX 1000 -MinY 0 -MaxY 1000
Assert-True ($s.Bounced) 'Hitting the bottom edge must report a bounce'
Assert-True ($s.Y -eq 1000) 'Hitting the bottom edge must clamp Y to MaxY'
Assert-True ([Math]::Abs($s.Angle + ($pi / 2)) -lt 1e-9) 'Bottom bounce must negate the heading'
# 斜向撞角：两个分量都反射，X 与 Y 都夹在边界内，且不会卡住（下一次仍能离开边界）
$s = Move-PetStep -X 995 -Y 995 -Angle ($pi / 4) -Speed 40 -Seconds 1 -MinX 0 -MaxX 1000 -MinY 0 -MaxY 1000
Assert-True ($s.X -eq 1000 -and $s.Y -eq 1000) 'Corner bounce must clamp both axes'
# 右下角入射 -> 反射为左上（-3PI/4，等价于 5PI/4）：cos 与 sin 同时变号
$normAngle = $s.Angle % $tau; if ($normAngle -lt 0) { $normAngle += $tau }
Assert-True ([Math]::Abs($normAngle - (5 * $pi / 4)) -lt 1e-9) 'Corner bounce must reflect both components'
Assert-True ([Math]::Cos($s.Angle) -lt 0 -and [Math]::Sin($s.Angle) -lt 0) 'Corner bounce must reverse both axis components'
$next = Move-PetStep -X $s.X -Y $s.Y -Angle $s.Angle -Speed 40 -Seconds 0.5 -MinX 0 -MaxX 1000 -MinY 0 -MaxY 1000
Assert-True ($next.X -lt 1000 -and $next.Y -lt 1000) 'Corner bounce must not stick to the corner'
# 退化输入：NaN/负速度/负时间/反转边界都不应抛错或产生 NaN
$s = Move-PetStep -X 10 -Y 10 -Angle ([double]::NaN) -Speed -5 -Seconds -1 -MinX 100 -MaxX 0 -MinY 100 -MaxY 0
Assert-True (-not [double]::IsNaN($s.X) -and -not [double]::IsNaN($s.Y) -and -not [double]::IsNaN($s.Angle)) 'Degenerate input must not produce NaN'
Assert-True ($s.X -ge 0 -and $s.Y -ge 0) 'Inverted bounds must be normalised'
# 长时间走动不会逃出工作区（模拟 2000 帧随机角度）
$x = 500.0; $y = 400.0; $ang = 0.0; $escaped = $false
for ($i = 0; $i -lt 2000; $i++) {
    if ($i % 7 -eq 0) { $ang = Get-PetRandomHeading }
    $s = Move-PetStep -X $x -Y $y -Angle $ang -Speed 40 -Seconds (1.0 / 8) -MinX 0 -MaxX 1000 -MinY 0 -MaxY 800
    $x = $s.X; $y = $s.Y; $ang = $s.Angle
    if ($x -lt 0 -or $x -gt 1000 -or $y -lt 0 -or $y -gt 800) { $escaped = $true; break }
}
Assert-True (-not $escaped) 'Long random walk must stay inside the work area'
$pets = @(Get-PetLibrary)
Assert-True ($pets.Count -eq 1) 'Standalone first launch must install Octocat'
Assert-True ((Read-PetJson (Join-Path $DataDir 'pet.json')).scale -eq 0.15) 'Fractional scale must survive'
$id = Import-LibraryPet (Join-Path $RepoDir 'assets\octocat.json') (Join-Path $RepoDir 'assets\octocat.png')
Assert-True (@(Get-PetLibrary).Count -eq 2) 'Native import must update library'
$source = Join-Path (Get-PetDirectory $id) 'pet.json'
$cfg = Read-PetJson $source
$cfg.name = 'native edited'; $cfg.behavior.lookAtCopilot = $true
Write-PetJson $source $cfg
Sync-PetSources
Assert-True ((Read-PetJson (Join-Path $DataDir 'pet.json')).name -eq 'native edited') 'Native library source hot reload failed'
$working = Read-PetJson (Join-Path $DataDir 'pet.json'); $working.name = 'direct edit'
Write-PetJson (Join-Path $DataDir 'pet.json') $working
Sync-PetSources
Assert-True ((Read-PetJson (Join-Path $DataDir 'pet.json')).name -eq 'direct edit') 'Old library must not overwrite working copy'
Remove-LibraryPet $id
Assert-True ((Get-ActivePetId) -ne $id) 'Deleting active pet must switch before removal'
Assert-True (-not (Test-Path -LiteralPath (Get-PetDirectory $id))) 'Native deletion failed'
$blocked = $false
try { Remove-LibraryPet (Get-ActivePetId) } catch { $blocked = $true }
Assert-True $blocked 'Last active pet must be protected'
$copy = Save-CurrentLibraryPet
Assert-True (@(Get-PetLibrary).Count -eq 2) 'Native save failed'

Add-Type -Path (Join-Path $RepoDir 'pet-win32.cs') -ReferencedAssemblies @('System.dll',[Windows.Int32Rect].Assembly.Location,[Windows.Automation.AutomationElement].Assembly.Location,[Windows.Automation.ControlType].Assembly.Location)
Assert-True ([PetWin32]::IsCopilotCandidate('copilot', '', 'renamed conversation')) 'Process identity lookup failed'
Assert-True (-not [PetWin32]::IsCopilotCandidate('chrome', '', 'GitHub Copilot')) 'Browser title must not match'
Assert-True ([PetWin32]::IsCopilotCandidate('electron', 'GitHub Copilot', 'renamed')) 'Product identity lookup failed'
$vector = [PetWin32]::VectorToCompose(400,200,500,300,100,100,900,900)
Assert-True ($vector[0] -ne 0 -or $vector[1] -ne 0) 'Overlapping app must still have a look vector'
$source = Get-Content (Join-Path $RepoDir 'pet-win32.cs') -Raw
Assert-True ($source.Contains('DateTime nextWindowScan') -and $source.Contains('now.AddMilliseconds(1000)')) 'Copilot window enumeration must be cached between scans'

# A real Win32 window with a session title and an accessible input control.
$exe = Join-Path $TestDir 'copilot.exe'
Add-Type -TypeDefinition @'
using System;
using System.Windows.Forms;
using System.Drawing;
public static class MockCopilot {
 [STAThread] public static void Main() {
  var form = new Form { Text = "Renamed conversation", StartPosition = FormStartPosition.Manual, Location = new Point(420,160), Size = new Size(700,600) };
  form.Controls.Add(new TextBox { Location = new Point(20,450), Size = new Size(600,70), Multiline = true, AccessibleName = "Message" });
  bool presented = false; var deadline = DateTime.UtcNow.AddSeconds(15);
  var timer = new Timer { Interval = 100 }; timer.Tick += delegate {
   if (!presented) { form.Hide(); form.Show(); form.Activate(); presented = true; }
   if (DateTime.UtcNow > deadline) form.Close();
  }; timer.Start();
  Application.Run(form);
 }
}
'@ -ReferencedAssemblies 'System.dll','System.Windows.Forms.dll','System.Drawing.dll' -OutputAssembly $exe -OutputType WindowsApplication
$mock = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden
try {
    $deadline = (Get-Date).AddSeconds(8)
    do { Start-Sleep -Milliseconds 100; $mock.Refresh(); $handle = $mock.MainWindowHandle } while ($handle -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline)
    Assert-True ($handle -ne [IntPtr]::Zero) 'Mock Copilot window did not start'
    Assert-True ([PetWin32]::FindCopilotWindow() -eq $handle) 'Renamed real window must be found by process'
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $vector = [PetWin32]::LookVector($handle)
    $clock.Stop()
    Assert-True ($null -ne $vector -and $vector[1] -gt 0) 'Real input-region/window lookup failed'
    Assert-True ($clock.ElapsedMilliseconds -lt 1000) 'Accessibility lookup must not block the animation dispatcher'
} finally { if (-not $mock.HasExited) { Stop-Process -Id $mock.Id -Force } }
Write-Output 'PASS: native data operations, config sync, C# compilation, real renamed Win32 target'
