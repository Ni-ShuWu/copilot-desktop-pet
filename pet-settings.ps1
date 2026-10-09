param([string]$ExtDir = $PSScriptRoot, [string]$DataDir = '', [string]$SnapshotPath = '')
$ErrorActionPreference = 'Stop'
if (-not $DataDir) { $DataDir = Join-Path $env:APPDATA 'copilot-desktop-pet' }
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
. (Join-Path $ExtDir 'pet-data.ps1')
Initialize-PetData

# Native WPF settings work with or without an extension/HTTP server.
[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
 Title="桌宠设置" Width="760" Height="570" MinWidth="620" MinHeight="470" WindowStartupLocation="CenterScreen"
 Background="#152033" Foreground="#E8EEF7" FontFamily="Segoe UI, Microsoft YaHei" FontSize="14">
 <Window.Resources>
  <Style TargetType="Button"><Setter Property="Padding" Value="12,7"/><Setter Property="Margin" Value="0,0,8,0"/><Setter Property="Background" Value="#202E44"/><Setter Property="Foreground" Value="#E8EEF7"/><Setter Property="BorderBrush" Value="#415572"/></Style>
  <Style TargetType="ListBoxItem"><Setter Property="Padding" Value="12"/><Setter Property="Margin" Value="0,0,0,4"/><Setter Property="HorizontalContentAlignment" Value="Stretch"/></Style>
 </Window.Resources>
 <Grid Margin="24">
  <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
  <StackPanel Margin="0,0,0,20"><TextBlock Text="桌宠库" FontSize="24" FontWeight="SemiBold"/><TextBlock Text="预览、切换和管理桌宠。配置与贴图可以任意顺序选择。" Margin="0,6,0,0" Foreground="#B6C7DC" TextWrapping="Wrap"/></StackPanel>
  <Grid Grid.Row="1">
   <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="240"/></Grid.ColumnDefinitions>
   <ListBox x:Name="PetList" Background="#152033" Foreground="#E8EEF7" BorderBrush="#34445D" ScrollViewer.HorizontalScrollBarVisibility="Disabled"/>
   <Grid Grid.Column="1" Margin="20,0,0,0">
    <Grid.RowDefinitions><RowDefinition Height="*"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
    <Border Background="#202E44" Padding="12"><Image x:Name="Preview" Stretch="Uniform" RenderOptions.BitmapScalingMode="NearestNeighbor"/></Border>
    <TextBlock Grid.Row="1" x:Name="PetName" Margin="0,12,0,6" FontWeight="SemiBold" TextWrapping="Wrap"/>
    <TextBlock Grid.Row="2" x:Name="ActiveLabel" Foreground="#79D7C9" Margin="0,0,0,12"/>
    <WrapPanel Grid.Row="3"><Button x:Name="Activate" Content="切换"/><Button x:Name="Delete" Content="删除…"/></WrapPanel>
   </Grid>
  </Grid>
  <WrapPanel Grid.Row="2" Margin="0,20,0,10"><Button x:Name="Save" Content="保存当前桌宠"/><Button x:Name="Folder" Content="打开库文件夹"/><Button x:Name="Edit" Content="编辑当前配置"/></WrapPanel>
  <WrapPanel Grid.Row="3"><Button x:Name="Config" Content="选择配置 JSON…"/><Button x:Name="Sprite" Content="选择贴图…"/><Button x:Name="Import" Content="导入并切换" IsEnabled="False"/></WrapPanel>
  <TextBlock Grid.Row="4" x:Name="Status" Text="先选择一只桌宠预览，或选择配置和贴图导入。" Margin="0,12,0,0" Foreground="#B6C7DC" TextWrapping="Wrap" MinHeight="38"/>
 </Grid>
</Window>
'@
$script:settingsWindow = [Windows.Markup.XamlReader]::Load((New-Object Xml.XmlNodeReader $xaml))
foreach ($name in @('PetList','Preview','PetName','ActiveLabel','Activate','Delete','Save','Folder','Edit','Config','Sprite','Import','Status')) {
    Set-Variable -Name ('settings' + $name) -Scope Script -Value $script:settingsWindow.FindName($name)
}
$script:pendingConfigPath = ''; $script:pendingSpritePath = ''; $script:librarySignature = ''; $script:previewFrame = 0
function Set-SettingsStatus([string]$Text, [bool]$ErrorState = $false) {
    $script:settingsStatus.Text = $Text
    $script:settingsStatus.Foreground = if ($ErrorState) { '#FFAAA5' } else { '#B6C7DC' }
}
function Update-SettingsPreview {
    $item = $script:settingsPetList.SelectedItem
    $script:settingsActivate.IsEnabled = $null -ne $item
    $script:settingsDelete.IsEnabled = $null -ne $item
    if (-not $item) { $script:settingsPreview.Source = $null; return }
    $pet = $item.Tag
    $script:settingsPetName.Text = $pet.Name
    $script:settingsActiveLabel.Text = if ($pet.Id -eq (Get-ActivePetId)) { '当前桌宠' } else { '可切换' }
    try {
        $image = New-Object Windows.Media.Imaging.BitmapImage
        $image.BeginInit(); $image.CacheOption = 'OnLoad'; $image.CreateOptions = 'IgnoreImageCache'
        $image.UriSource = New-Object Uri((Join-Path $pet.Directory ([string]$pet.Config.sprite))); $image.EndInit(); $image.Freeze()
        $anim = $pet.Config.animations.([string]$pet.Config.defaultAnimation)
        if (-not $anim) { $anim = $pet.Config.animations.idle }
        $frames = [Math]::Max(1, [int]$anim.frames)
        $rect = New-Object Windows.Int32Rect(($script:previewFrame % $frames) * [int]$pet.Config.frameWidth), ([int]$anim.row * [int]$pet.Config.frameHeight), ([int]$pet.Config.frameWidth), ([int]$pet.Config.frameHeight)
        $script:settingsPreview.Source = New-Object Windows.Media.Imaging.CroppedBitmap($image, $rect)
    } catch { $script:settingsPreview.Source = $null; Set-SettingsStatus ('预览失败：' + $_.Exception.Message) $true }
}
function Refresh-SettingsLibrary([bool]$Force = $false) {
    Sync-PetSources
    $pets = @(Get-PetLibrary)
    $signature = (Get-ActivePetId) + ($pets | ForEach-Object { $_.Id + (Get-PetHash (Join-Path $_.Directory 'pet.json')) } | Out-String)
    if (-not $Force -and $signature -eq $script:librarySignature) { return }
    $script:librarySignature = $signature
    $selected = if ($script:settingsPetList.SelectedItem) { $script:settingsPetList.SelectedItem.Tag.Id } else { Get-ActivePetId }
    $script:settingsPetList.Items.Clear()
    foreach ($pet in $pets) {
        $item = New-Object Windows.Controls.ListBoxItem
        $item.Content = $pet.Name; $item.Tag = $pet
        $script:settingsPetList.Items.Add($item) | Out-Null
        if ($pet.Id -eq $selected) { $script:settingsPetList.SelectedItem = $item }
    }
    if (-not $script:settingsPetList.SelectedItem -and $pets.Count) { $script:settingsPetList.SelectedIndex = 0 }
    Update-SettingsPreview
}
function Invoke-SettingsAction([scriptblock]$Action) {
    try { & $Action; Refresh-SettingsLibrary $true }
    catch { Set-SettingsStatus $_.Exception.Message $true }
}
function Select-SettingsFile([bool]$IsConfig) {
    $dialog = New-Object Microsoft.Win32.OpenFileDialog
    $dialog.Filter = if ($IsConfig) { '配置 JSON|*.json' } else { '桌宠贴图|*.png;*.gif;*.webp' }
    if (-not $dialog.ShowDialog($script:settingsWindow)) { return }
    if ($IsConfig) { $script:pendingConfigPath = $dialog.FileName } else { $script:pendingSpritePath = $dialog.FileName }
    $script:settingsImport.IsEnabled = [bool]($script:pendingConfigPath -and $script:pendingSpritePath)
    Set-SettingsStatus ('配置：' + [IO.Path]::GetFileName($script:pendingConfigPath) + '；贴图：' + [IO.Path]::GetFileName($script:pendingSpritePath))
}
$script:settingsPetList.Add_SelectionChanged({ $script:previewFrame = 0; Update-SettingsPreview })
$script:settingsConfig.Add_Click({ Select-SettingsFile $true })
$script:settingsSprite.Add_Click({ Select-SettingsFile $false })
$script:settingsImport.Add_Click({ Invoke-SettingsAction {
    Import-LibraryPet $script:pendingConfigPath $script:pendingSpritePath | Out-Null
    $script:pendingConfigPath = ''; $script:pendingSpritePath = ''; $script:settingsImport.IsEnabled = $false
    Set-SettingsStatus '已导入并切换，新桌宠已出现在库中。'
} })
$script:settingsActivate.Add_Click({ Invoke-SettingsAction { Activate-LibraryPet $script:settingsPetList.SelectedItem.Tag.Id; Set-SettingsStatus '已切换桌宠。' } })
$script:settingsDelete.Add_Click({
    $pet = $script:settingsPetList.SelectedItem.Tag
    if ([Windows.MessageBox]::Show($script:settingsWindow, ('删除「' + $pet.Name + '」及其库内配置和贴图？'), '删除桌宠', 'YesNo', 'Warning') -eq 'Yes') {
        Invoke-SettingsAction { Remove-LibraryPet $pet.Id; Set-SettingsStatus '已删除桌宠。' }
    }
})
$script:settingsSave.Add_Click({ Invoke-SettingsAction { Save-CurrentLibraryPet | Out-Null; Set-SettingsStatus '已保存当前桌宠副本。' } })
$script:settingsFolder.Add_Click({ Start-Process explorer.exe -ArgumentList ('"' + (Join-Path $DataDir 'pets') + '"') })
$script:settingsEdit.Add_Click({ Start-Process notepad.exe -ArgumentList ('"' + (Join-Path $DataDir 'pet.json') + '"') })
$script:settingsTimer = New-Object Windows.Threading.DispatcherTimer
$script:settingsTimer.Interval = [TimeSpan]::FromMilliseconds(250)
$script:settingsTimer.Add_Tick({
    try { Refresh-SettingsLibrary; $script:previewFrame++; Update-SettingsPreview }
    catch { Set-SettingsStatus $_.Exception.Message $true }
})
$script:settingsWindow.Add_Closed({ $script:settingsTimer.Stop() })
Refresh-SettingsLibrary $true
if ($SnapshotPath) {
    # Render the actual WPF tree for automated visual QA without leaving a window open.
    $script:settingsWindow.Show(); $script:settingsWindow.UpdateLayout()
    $content = $script:settingsWindow.Content
    $width = [int]$content.ActualWidth + 48; $height = [int]$content.ActualHeight + 48
    $visual = New-Object Windows.Media.DrawingVisual
    $drawing = $visual.RenderOpen()
    $drawing.DrawRectangle([Windows.Media.BrushConverter]::new().ConvertFromString('#152033'), $null, (New-Object Windows.Rect(0,0,$width,$height)))
    $drawing.DrawRectangle((New-Object Windows.Media.VisualBrush($content)), $null, (New-Object Windows.Rect(24,24,$content.ActualWidth,$content.ActualHeight)))
    $drawing.Close()
    $render = New-Object Windows.Media.Imaging.RenderTargetBitmap($width,$height,96,96,[Windows.Media.PixelFormats]::Pbgra32)
    $render.Render($visual)
    $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder
    $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($render))
    $stream = [IO.File]::Create($SnapshotPath)
    try { $encoder.Save($stream) } finally { $stream.Dispose(); $script:settingsWindow.Close() }
} else { $script:settingsTimer.Start(); $script:settingsWindow.ShowDialog() | Out-Null }
