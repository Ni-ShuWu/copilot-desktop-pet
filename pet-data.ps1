# Shared disk protocol for the standalone pet and native settings (PowerShell 5.1).
function Write-PetJson([string]$Path, $Value) {
    $temporary = $Path + "." + $PID + ".tmp"
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 40), (New-Object Text.UTF8Encoding $false))
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
    else { [IO.File]::Move($temporary, $Path) }
}
function Read-PetJson([string]$Path) {
    return ([IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json)
}
function Get-PetHash([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $raw = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($raw)))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
}
function Get-PetDirectory([string]$Id) {
    if ($Id -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw '无效的桌宠编号' }
    return (Join-Path (Join-Path $DataDir 'pets') $Id)
}
function Get-ActivePetId {
    try { return [string](Read-PetJson (Join-Path $DataDir 'pets\active.json')).id } catch { return '' }
}
function Save-PetSourceSnapshot {
    $id = Get-ActivePetId
    $library = $null
    if ($id) { $library = Get-PetHash (Join-Path (Get-PetDirectory $id) 'pet.json') }
    Write-PetJson (Join-Path $DataDir '.config-sources.json') @{ legacy = (Get-PetHash (Join-Path $ExtDir 'pet.json')); id = $id; library = $library }
}
function Convert-PetConfig($Config) {
    if ($null -eq $Config -or $Config -is [array] -or $Config -isnot [pscustomobject]) { throw '配置必须是 JSON 对象' }
    $defaults = Read-PetJson (Join-Path $ExtDir 'pet.example.json')
    if ($Config.cell -and $Config.cell.Count -ge 2) {
        if (-not $Config.frameWidth) { $Config | Add-Member frameWidth ([int]$Config.cell[0]) -Force }
        if (-not $Config.frameHeight) { $Config | Add-Member frameHeight ([int]$Config.cell[1]) -Force }
        if (-not $Config.scale) { $Config | Add-Member scale 1 -Force }
    }
    foreach ($property in $defaults.PSObject.Properties) {
        if ($null -eq $Config.($property.Name)) { $Config | Add-Member $property.Name $property.Value -Force }
    }
    foreach ($section in @('behavior', 'speech', 'chat', 'externalEvents')) {
        foreach ($property in $defaults.$section.PSObject.Properties) {
            if ($null -eq $Config.$section.($property.Name)) { $Config.$section | Add-Member $property.Name $property.Value -Force }
        }
    }
    if ($Config.frameWidth -le 0 -or $Config.frameHeight -le 0 -or $Config.scale -le 0) { throw '帧尺寸和缩放必须大于零' }
    return $Config
}
function Set-PetFromSource([string]$Source, [string]$Id) {
    $cfg = Read-PetJson $Source
    $sprite = [string]$cfg.sprite
    if ([IO.Path]::GetFileName($sprite) -ne $sprite -or $sprite -notmatch '\.(png|gif|webp)$') { throw '配置中的贴图路径无效' }
    if ($Id) { $cfg.sprite = "pets/$Id/$sprite" }
    else { Copy-Item -LiteralPath (Join-Path (Split-Path $Source) $sprite) -Destination (Join-Path $DataDir $sprite) -Force }
    Write-PetJson (Join-Path $DataDir 'pet.json') $cfg
}
function Sync-PetSources {
    $journalPath = Join-Path $DataDir '.config-sources.json'
    $legacyPath = Join-Path $ExtDir 'pet.json'
    if (-not (Test-Path -LiteralPath $journalPath)) {
        if ((Test-Path -LiteralPath $legacyPath) -and (Get-Item -LiteralPath $legacyPath).LastWriteTimeUtc -gt (Get-Item -LiteralPath (Join-Path $DataDir 'pet.json')).LastWriteTimeUtc) {
            Set-PetFromSource $legacyPath ''
        }
        Save-PetSourceSnapshot
        return
    }
    $previous = Read-PetJson $journalPath
    $id = Get-ActivePetId
    $legacy = Get-PetHash $legacyPath
    $library = $null
    if ($id) { $library = Get-PetHash (Join-Path (Get-PetDirectory $id) 'pet.json') }
    if ($legacy -and $legacy -ne $previous.legacy) {
        Set-PetFromSource $legacyPath ''
        Write-PetJson (Join-Path $DataDir 'pets\active.json') @{ id = '' }
    } elseif ($id -eq $previous.id -and $library -and $library -ne $previous.library) {
        Set-PetFromSource (Join-Path (Get-PetDirectory $id) 'pet.json') $id
    } elseif ($id -eq $previous.id -and $legacy -eq $previous.legacy -and $library -eq $previous.library) { return }
    Save-PetSourceSnapshot
}
function Initialize-PetData {
    New-Item -ItemType Directory -Path (Join-Path $DataDir 'pets') -Force | Out-Null
    $builtinId = '00000000-0000-4000-8000-000000000001'
    $builtinDir = Get-PetDirectory $builtinId
    if (-not (Test-Path -LiteralPath (Join-Path $DataDir '.builtin-installed'))) {
        New-Item -ItemType Directory -Path $builtinDir -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $ExtDir 'assets\octocat.png') -Destination $builtinDir -Force
        Copy-Item -LiteralPath (Join-Path $ExtDir 'assets\octocat.json') -Destination (Join-Path $builtinDir 'pet.json') -Force
        [IO.File]::WriteAllText((Join-Path $DataDir '.builtin-installed'), '')
    }
    $working = Join-Path $DataDir 'pet.json'
    if (-not (Test-Path -LiteralPath $working)) {
        if (Test-Path -LiteralPath (Join-Path $ExtDir 'pet.json')) { Copy-Item -LiteralPath (Join-Path $ExtDir 'pet.json') -Destination $working }
        else { Set-PetFromSource (Join-Path $builtinDir 'pet.json') $builtinId; Write-PetJson (Join-Path $DataDir 'pets\active.json') @{ id = $builtinId } }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $DataDir '.legacy-data-migrated'))) {
        Get-ChildItem -LiteralPath $ExtDir -File | Where-Object { $_.Extension -in '.png', '.gif', '.webp' } | ForEach-Object {
            $target = Join-Path $DataDir $_.Name
            if (-not (Test-Path -LiteralPath $target)) { Copy-Item -LiteralPath $_.FullName -Destination $target }
        }
        $oldLibrary = Join-Path $ExtDir 'pets'
        if (Test-Path -LiteralPath $oldLibrary) {
            Get-ChildItem -LiteralPath $oldLibrary -Recurse -File | ForEach-Object {
                $relative = $_.FullName.Substring($oldLibrary.Length).TrimStart('\', '/')
                $target = Join-Path (Join-Path $DataDir 'pets') $relative
                if (-not (Test-Path -LiteralPath $target)) {
                    New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
                    Copy-Item -LiteralPath $_.FullName -Destination $target
                }
            }
        }
        [IO.File]::WriteAllText((Join-Path $DataDir '.legacy-data-migrated'), '')
    }
    Sync-PetSources
}
function Get-PetLibrary {
    foreach ($dir in Get-ChildItem -LiteralPath (Join-Path $DataDir 'pets') -Directory) {
        try {
            $validated = Get-PetDirectory $dir.Name
            $cfg = Convert-PetConfig (Read-PetJson (Join-Path $validated 'pet.json'))
            [pscustomobject]@{ Id = $dir.Name; Name = [string]$cfg.name; Config = $cfg; Directory = $validated }
        } catch {}
    }
}
function Activate-LibraryPet([string]$Id) {
    $dir = Get-PetDirectory $Id
    $cfg = Convert-PetConfig (Read-PetJson (Join-Path $dir 'pet.json'))
    $sprite = [string]$cfg.sprite
    if ([IO.Path]::GetFileName($sprite) -ne $sprite -or -not (Test-Path -LiteralPath (Join-Path $dir $sprite))) { throw '找不到桌宠贴图' }
    $cfg.sprite = "pets/$Id/$sprite"
    Write-PetJson (Join-Path $DataDir 'pet.json') $cfg
    Write-PetJson (Join-Path $DataDir 'pets\active.json') @{ id = $Id }
    Save-PetSourceSnapshot
}
function Import-LibraryPet([string]$ConfigPath, [string]$SpritePath) {
    $cfg = Convert-PetConfig (Read-PetJson $ConfigPath)
    $ext = [IO.Path]::GetExtension($SpritePath).ToLowerInvariant()
    if ($ext -notin '.png', '.gif', '.webp') { throw '贴图仅支持 PNG、GIF 或 WebP' }
    if ((Get-Item -LiteralPath $SpritePath).Length -gt 12MB) { throw '贴图超过 12 MB' }
    # Decode before storing so malformed image data cannot create a broken pet.
    $bitmap = New-Object Windows.Media.Imaging.BitmapImage
    $bitmap.BeginInit(); $bitmap.CacheOption = 'OnLoad'; $bitmap.UriSource = New-Object Uri([IO.Path]::GetFullPath($SpritePath)); $bitmap.EndInit(); $bitmap.Freeze()
    $id = [Guid]::NewGuid().ToString()
    $dir = Get-PetDirectory $id
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $cfg.sprite = 'spritesheet' + $ext
    Copy-Item -LiteralPath $SpritePath -Destination (Join-Path $dir $cfg.sprite)
    Write-PetJson (Join-Path $dir 'pet.json') $cfg
    Activate-LibraryPet $id
    return $id
}
function Save-CurrentLibraryPet {
    Sync-PetSources
    $cfg = Convert-PetConfig (Read-PetJson (Join-Path $DataDir 'pet.json'))
    $sprite = Join-Path $DataDir ([string]$cfg.sprite)
    if (-not (Test-Path -LiteralPath $sprite)) { $sprite = Join-Path $ExtDir ([string]$cfg.sprite) }
    if (-not (Test-Path -LiteralPath $sprite)) { throw '找不到当前桌宠贴图' }
    $id = [Guid]::NewGuid().ToString()
    $dir = Get-PetDirectory $id
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $cfg.sprite = [IO.Path]::GetFileName($sprite)
    Copy-Item -LiteralPath $sprite -Destination (Join-Path $dir $cfg.sprite)
    Write-PetJson (Join-Path $dir 'pet.json') $cfg
    return $id
}
function Remove-LibraryPet([string]$Id) {
    $dir = Get-PetDirectory $Id
    if (-not (Test-Path -LiteralPath (Join-Path $dir 'pet.json'))) { throw '找不到该桌宠' }
    $working = Read-PetJson (Join-Path $DataDir 'pet.json')
    if ((Get-ActivePetId) -eq $Id -or ([string]$working.sprite).Replace('\', '/').StartsWith("pets/$Id/")) {
        $other = @(Get-PetLibrary | Where-Object { $_.Id -ne $Id })
        if (-not $other.Count) { throw '请先导入或保存另一只桌宠，再删除当前桌宠' }
        Activate-LibraryPet $other[0].Id
    }
    $resolved = [IO.Path]::GetFullPath($dir)
    $root = [IO.Path]::GetFullPath((Join-Path $DataDir 'pets')) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw '桌宠目录越界' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
