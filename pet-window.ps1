# desktop-pet 桌面悬浮窗（WPF 透明置顶窗，类 Codex 桌宠）
# 由 extension.mjs 拉起：powershell -STA -File pet-window.ps1 -ExtDir <dir> -StateUrl <url>
# 也可直接双击/手动运行（不带参数）：ExtDir 默认脚本所在目录，StateUrl 为空则独立模式（不联动会话状态）
param(
    [string]$ExtDir = $PSScriptRoot,
    [string]$StateUrl = ""
)

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$script:configPath = Join-Path $ExtDir "pet.json"

function Read-PetConfig {
    try {
        $raw = Get-Content -Raw -Encoding UTF8 $script:configPath
        return ($raw | ConvertFrom-Json)
    } catch {
        return $null
    }
}

$script:cfg = Read-PetConfig
if ($null -eq $script:cfg) { exit 1 }

$script:fw = [int]$script:cfg.frameWidth
$script:fh = [int]$script:cfg.frameHeight
$script:scale = if ($script:cfg.scale) { [int]$script:cfg.scale } else { 4 }
$script:fps = if ($script:cfg.fps) { [double]$script:cfg.fps } else { 8 }
$script:spriteW = $script:fw * $script:scale
$script:spriteH = $script:fh * $script:scale
$script:bubbleH = 64
$script:spriteBaseTop = $script:bubbleH

# ---- 轮询间隔（pet.json 的 pollIntervalMs，clamp 100..5000，默认 250） ----
function Get-PollIntervalMs {
    $ms = 250
    try {
        if ($null -ne $script:cfg.pollIntervalMs) { $ms = [int]$script:cfg.pollIntervalMs }
    } catch {}
    if ($ms -lt 100) { $ms = 100 }      # 下限：再快没有意义，只会空转
    if ($ms -gt 5000) { $ms = 5000 }    # 上限：配置写错也不至于把服务打爆
    return $ms
}
$script:pollMs = Get-PollIntervalMs

# 实际生效间隔 = 配置间隔 与「连接中断」退避值 的较大者（断连期间自动降频）
function Update-PollInterval {
    $ms = $script:pollMs
    if (-not $script:pollOk -and $script:backoffMs -gt $ms) { $ms = $script:backoffMs }
    if ($ms -lt 100) { $ms = 100 }
    $pollTimer.Interval = [TimeSpan]::FromMilliseconds($ms)
}

function Load-Bitmap([string]$file) {
    $bmp = New-Object System.Windows.Media.Imaging.BitmapImage
    $bmp.BeginInit()
    $bmp.UriSource = New-Object System.Uri($file)
    $bmp.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
    $bmp.EndInit()
    $bmp.Freeze()
    return $bmp
}

$script:spritePath = Join-Path $ExtDir ([string]$script:cfg.sprite)
if (-not (Test-Path $script:spritePath)) { exit 1 }
$script:bitmap = Load-Bitmap $script:spritePath

$winW = $script:spriteW + 24
$winH = $script:spriteH + $script:bubbleH + 16
$shadowW = [int]($script:spriteW * 0.6)
$shadowL = [int](12 + $script:spriteW * 0.2)
$shadowT = $script:bubbleH + $script:spriteH - 8
$bubbleW = $winW - 8
$badgeL = $winW - 32

$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False"
        Width="$winW" Height="$winH">
  <Canvas x:Name="Root">
    <Border x:Name="Bubble" Canvas.Left="4" Canvas.Top="0" Width="$bubbleW"
            Background="White" CornerRadius="10" Padding="8,5"
            BorderBrush="#33000000" BorderThickness="1" Visibility="Collapsed">
      <TextBlock x:Name="BubbleText" TextWrapping="Wrap" TextAlignment="Center"
                 FontSize="13" Foreground="#1F2328"/>
    </Border>
    <Ellipse x:Name="Shadow" Width="$shadowW" Height="10"
             Canvas.Left="$shadowL" Canvas.Top="$shadowT"
             Fill="Black" Opacity="0.18">
      <Ellipse.Effect><BlurEffect Radius="4"/></Ellipse.Effect>
    </Ellipse>
    <Image x:Name="Sprite" Width="$spriteW" Height="$spriteH"
           Canvas.Left="12" Canvas.Top="$($script:spriteBaseTop)"
           RenderOptions.BitmapScalingMode="NearestNeighbor"
           RenderTransformOrigin="0.5,0.5"/>
    <TextBlock x:Name="Badge" Text="&#x1F6E0;" FontSize="16"
               Canvas.Left="$badgeL" Canvas.Top="$($script:spriteBaseTop + 2)"
               Visibility="Collapsed"/>
  </Canvas>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader([xml]$xaml)
$window = [Windows.Markup.XamlReader]::Load($reader)
$sprite = $window.FindName("Sprite")
$shadow = $window.FindName("Shadow")
$bubble = $window.FindName("Bubble")
$bubbleText = $window.FindName("BubbleText")
$badge = $window.FindName("Badge")

# ---- 状态 ----
$script:mode = "idle"          # idle | walk | sleep
$script:dir = 1
$script:frame = 0
$script:hopY = 0.0
$script:hopV = 0.0
$script:overrideAnim = $null
$script:activity = "idle"
$script:lastMsg = $null
$script:bubbleUntil = [DateTime]::MinValue
$script:lastInteraction = Get-Date
$script:nextDecision = (Get-Date).AddSeconds(3)
$script:failCount = 0
$script:pollCount = 0
# 「连接中断」保活态：连续失败不再关窗自杀，只降频重试 + 气泡提示一次
$script:pollOk = $true
$script:backoffMs = 250            # 断连退避：250 → 500 → 1000 → 2000 → 5000（封顶）
$script:disconnNotified = $false   # 同一段断连只提示一次
$script:configWriteTime = (Get-Item $script:configPath).LastWriteTime
$script:autoWander = $true
try { $script:autoWander = [bool]$script:cfg.behavior.autoWander } catch {}
$script:downPos = New-Object System.Drawing.Point(0, 0)

$wa = [System.Windows.SystemParameters]::WorkArea
$window.Left = $wa.Right - $window.Width - 60
$window.Top = $wa.Bottom - $window.Height - 12

function Get-AnimDef([string]$name) {
    if ($null -eq $script:cfg.animations) { return $null }
    $prop = $script:cfg.animations.PSObject.Properties[$name]
    if ($null -eq $prop) { return $null }
    return $prop.Value
}

function Resolve-AnimName {
    if ($script:overrideAnim -and (Get-AnimDef $script:overrideAnim)) { return $script:overrideAnim }
    if ($script:mode -eq "sleep" -and (Get-AnimDef "sleep")) { return "sleep" }
    if ($script:activity -eq "working" -and (Get-AnimDef "work")) { return "work" }
    if ($script:mode -eq "walk" -and (Get-AnimDef "walk")) { return "walk" }
    $d = [string]$script:cfg.defaultAnimation
    if (Get-AnimDef $d) { return $d }
    return "idle"
}

# 配置热更新后重新应用几何（帧尺寸/缩放变化时窗口与元素都要跟着变）
function Update-Geometry {
    $script:fw = [int]$script:cfg.frameWidth
    $script:fh = [int]$script:cfg.frameHeight
    $script:scale = if ($script:cfg.scale) { [int]$script:cfg.scale } else { 4 }
    $script:fps = if ($script:cfg.fps) { [double]$script:cfg.fps } else { 8 }
    $script:spriteW = $script:fw * $script:scale
    $script:spriteH = $script:fh * $script:scale
    $winW = $script:spriteW + 24
    $winH = $script:spriteH + $script:bubbleH + 16
    $window.Width = $winW
    $window.Height = $winH
    $sprite.Width = $script:spriteW
    $sprite.Height = $script:spriteH
    $bubble.Width = $winW - 8
    $shadow.Width = [int]($script:spriteW * 0.6)
    [System.Windows.Controls.Canvas]::SetLeft($shadow, 12 + $script:spriteW * 0.2)
    [System.Windows.Controls.Canvas]::SetTop($shadow, $script:bubbleH + $script:spriteH - 8)
    [System.Windows.Controls.Canvas]::SetLeft($badge, $winW - 32)
    $animTimer.Interval = [TimeSpan]::FromMilliseconds([Math]::Max(30, 1000.0 / $script:fps))
    $script:frame = 0
}

function Show-Bubble([string]$text, [int]$ms) {
    $bubbleText.Text = $text
    $bubble.Visibility = "Visible"
    $script:bubbleUntil = (Get-Date).AddMilliseconds($ms)
}

function Poke {
    $phrases = $null
    try { $phrases = $script:cfg.speech.phrases } catch {}
    if ($phrases -and $phrases.Count -gt 0) {
        Show-Bubble ([string]($phrases | Get-Random)) 1800
    }
}

function Update-SpriteFrame {
    $animName = Resolve-AnimName
    $anim = Get-AnimDef $animName
    $row = 0; $frames = 1
    if ($null -ne $anim) {
        $row = [int]$anim.row
        $frames = [int]$anim.frames
        if ($frames -lt 1) { $frames = 1 }
    }
    $script:frame = ($script:frame + 1) % $frames
    $flip = $script:dir
    if ($script:dir -lt 0 -and $null -ne $anim.leftRow) {
        $row = [int]$anim.leftRow   # 贴图自带左行帧（方向已烘焙），无需镜像
        $flip = 1
    }
    $rect = New-Object System.Windows.Int32Rect(($script:frame * $script:fw), ($row * $script:fh), $script:fw, $script:fh)
    $sprite.Source = New-Object System.Windows.Media.Imaging.CroppedBitmap($script:bitmap, $rect)
    $sprite.RenderTransform = New-Object System.Windows.Media.ScaleTransform($flip, 1)
}

function Decide {
    $min = 3.0; $max = 8.0
    try {
        $range = $script:cfg.behavior.wanderIntervalSec
        if ($range -and $range.Count -ge 2) { $min = [double]$range[0]; $max = [double]$range[1] }
    } catch {}
    $span = [int](($max - $min) * 10)
    if ($span -lt 1) { $span = 10 }
    $script:nextDecision = (Get-Date).AddSeconds($min + (Get-Random -Minimum 0 -Maximum $span) / 10.0)

    if (-not $script:autoWander) { $script:mode = "idle"; return }
    if ($script:activity -eq "working" -and (Get-AnimDef "work")) {
        if ($script:mode -ne "sleep") { $script:mode = "idle" }   # agent 工作中：坐下敲电脑，不乱跑
        return
    }

    $sleepAfter = 45.0
    try { if ($script:cfg.behavior.sleepAfterIdleSec) { $sleepAfter = [double]$script:cfg.behavior.sleepAfterIdleSec } } catch {}
    $idleSec = ((Get-Date) - $script:lastInteraction).TotalSeconds
    if ($sleepAfter -gt 0 -and $idleSec -gt $sleepAfter -and (Get-AnimDef "sleep")) {
        $script:mode = "sleep"
        return
    }
    if ($script:mode -eq "sleep") { return }

    if ((Get-Random -Minimum 0 -Maximum 100) -lt 55 -and (Get-AnimDef "walk")) {
        $script:mode = "walk"
        $script:dir = (Get-Random -Minimum 0 -Maximum 2) * 2 - 1
    } else {
        $script:mode = "idle"
    }
}

# ---- 动画/行为定时器 ----
$script:lastTick = Get-Date
$animTimer = New-Object System.Windows.Threading.DispatcherTimer
$animTimer.Interval = [TimeSpan]::FromMilliseconds([Math]::Max(30, 1000.0 / $script:fps))
$animTimer.Add_Tick({
    $now = Get-Date
    $dt = ($now - $script:lastTick).TotalSeconds
    $script:lastTick = $now
    if ($dt -gt 0.1) { $dt = 0.1 }

    Update-SpriteFrame

    if (-not $script:overrideAnim -and $now -ge $script:nextDecision) { Decide }

    if ($script:mode -eq "walk") {
        $speed = 40.0
        try { if ($script:cfg.behavior.walkSpeedPxPerSec) { $speed = [double]$script:cfg.behavior.walkSpeedPxPerSec } } catch {}
        $waNow = [System.Windows.SystemParameters]::WorkArea
        $newLeft = $window.Left + $script:dir * $speed * $dt
        if ($newLeft -le $waNow.Left) { $newLeft = $waNow.Left; $script:dir = 1 }
        if ($newLeft -ge ($waNow.Right - $window.Width)) { $newLeft = $waNow.Right - $window.Width; $script:dir = -1 }
        $window.Left = $newLeft
    }

    if ($script:hopV -ne 0 -or $script:hopY -ne 0) {
        $script:hopY -= $script:hopV * $dt
        $script:hopV -= 900.0 * $dt
        if ($script:hopY -ge 0) { $script:hopY = 0; $script:hopV = 0 }
        [System.Windows.Controls.Canvas]::SetTop($sprite, $script:spriteBaseTop + $script:hopY)
        [System.Windows.Controls.Canvas]::SetTop($shadow, $shadowT - $script:hopY * 0.15)
    }

    if ($script:bubbleUntil -ne [DateTime]::MinValue -and $now -gt $script:bubbleUntil) {
        $script:bubbleUntil = [DateTime]::MinValue
        $bubble.Visibility = "Collapsed"
    }
})

# ---- 指令轮询（agent 动作 / 配置热更新 / 保活） ----
$pollTimer = New-Object System.Windows.Threading.DispatcherTimer
$pollTimer.Interval = [TimeSpan]::FromMilliseconds($script:pollMs)
$pollTimer.Add_Tick({
    $script:pollCount += 1

    if ($script:pollCount % 4 -eq 1) {
        try {
            $wt = (Get-Item $script:configPath).LastWriteTime
            if ($wt -ne $script:configWriteTime) {
                $script:configWriteTime = $wt
                $newCfg = Read-PetConfig
                if ($null -ne $newCfg) {
                    $geomChanged = ([int]$newCfg.frameWidth -ne $script:fw) -or ([int]$newCfg.frameHeight -ne $script:fh)
                    $newScale = if ($newCfg.scale) { [int]$newCfg.scale } else { 4 }
                    if ($newScale -ne $script:scale) { $geomChanged = $true }
                    $newFps = if ($newCfg.fps) { [double]$newCfg.fps } else { 8 }
                    if ($newFps -ne $script:fps) { $geomChanged = $true }
                    $newSprite = Join-Path $ExtDir ([string]$newCfg.sprite)
                    if ($newSprite -ne $script:spritePath -and (Test-Path $newSprite)) {
                        $script:spritePath = $newSprite
                        $script:bitmap = Load-Bitmap $newSprite
                    }
                    $script:cfg = $newCfg
                    if ($geomChanged) { Update-Geometry }
                    try { $script:autoWander = [bool]$script:cfg.behavior.autoWander } catch {}
                    # 配置热重载：pollIntervalMs 变化时同步 DispatcherTimer 间隔
                    $newPollMs = Get-PollIntervalMs
                    if ($newPollMs -ne $script:pollMs) {
                        $script:pollMs = $newPollMs
                        Update-PollInterval
                    }
                }
            }
        } catch {}
    }

    if ($StateUrl -eq "") { return }   # 独立模式：不轮询、不退出（进程常驻）
    try {
        $s = Invoke-RestMethod -Uri ($StateUrl + "api/state") -Method Get -TimeoutSec 2
        $script:failCount = 0
        if (-not $script:pollOk) {
            # 服务恢复：回到正常态，退避与「只提示一次」标记一起复位
            $script:pollOk = $true
            $script:backoffMs = 250
            $script:disconnNotified = $false
            Update-PollInterval
        }
        if ($s.animation) { $script:overrideAnim = [string]$s.animation } else { $script:overrideAnim = $null }
        if ($s.message) {
            $msg = [string]$s.message
            if ($msg -ne $script:lastMsg) { $script:lastMsg = $msg; Show-Bubble $msg 4500 }
        } else {
            $script:lastMsg = $null
        }
        if ($s.activity -eq "working") {
            $script:activity = "working"
            $badge.Visibility = "Visible"
            if ($script:mode -eq "sleep") { $script:mode = "idle"; $script:lastInteraction = Get-Date }
            if ($script:mode -eq "walk") { $script:mode = "idle" }
        } else {
            $script:activity = "idle"
            $badge.Visibility = "Collapsed"
        }
    } catch {
        # 连接中断：绝不关窗自杀（原 failCount>=10 的自动退出已删除），进程始终不退，只降频重试
        $script:failCount += 1
        if ($script:pollOk) {
            $script:pollOk = $false
            $script:backoffMs = 250
            if (-not $script:disconnNotified) {
                $script:disconnNotified = $true
                Show-Bubble "连接中断，正在等待桌宠服务恢复……" 4500
            }
        } else {
            # 指数退避：250 → 500 → 1000 → 2000 → 5000（封顶）
            $next = $script:backoffMs * 2
            if ($next -gt 5000) { $next = 5000 }
            $script:backoffMs = $next
        }
        Update-PollInterval
    }
})

# ---- 鼠标交互 ----
$window.Add_MouseLeftButtonDown({
    $script:lastInteraction = Get-Date
    if ($script:mode -eq "sleep") { $script:mode = "idle" }
    $script:downPos = [System.Windows.Forms.Cursor]::Position
    try { $window.DragMove() } catch {}
})

$window.Add_MouseLeftButtonUp({
    $up = [System.Windows.Forms.Cursor]::Position
    $dist = [Math]::Abs($up.X - $script:downPos.X) + [Math]::Abs($up.Y - $script:downPos.Y)
    if ($dist -lt 6) { Poke }
    $script:lastInteraction = Get-Date
    $waNow = [System.Windows.SystemParameters]::WorkArea
    if ($window.Left -lt $waNow.Left) { $window.Left = $waNow.Left }
    if ($window.Left -gt ($waNow.Right - $window.Width)) { $window.Left = $waNow.Right - $window.Width }
    if ($window.Top -lt $waNow.Top) { $window.Top = $waNow.Top }
    if ($window.Top -gt ($waNow.Bottom - $window.Height)) { $window.Top = $waNow.Bottom - $window.Height }
})

# ---- 右键菜单 ----
$menu = New-Object System.Windows.Controls.ContextMenu

$itemWander = New-Object System.Windows.Controls.MenuItem
$itemWander.Header = "自动走动 开/关"
$itemWander.Add_Click({ $script:autoWander = -not $script:autoWander })
$menu.Items.Add($itemWander) | Out-Null

$itemSleep = New-Object System.Windows.Controls.MenuItem
$itemSleep.Header = "睡觉 / 醒来"
$itemSleep.Add_Click({
    if ($script:mode -eq "sleep") { $script:mode = "idle"; $script:lastInteraction = Get-Date }
    else { $script:mode = "sleep" }
})
$menu.Items.Add($itemSleep) | Out-Null

$menu.Items.Add((New-Object System.Windows.Controls.Separator)) | Out-Null

$itemExit = New-Object System.Windows.Controls.MenuItem
$itemExit.Header = "退出"
$itemExit.Add_Click({ $window.Close() })
$menu.Items.Add($itemExit) | Out-Null

$window.ContextMenu = $menu

$animTimer.Start()
$pollTimer.Start()
$window.ShowDialog() | Out-Null
