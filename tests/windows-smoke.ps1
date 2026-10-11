param([string]$RepoDir, [string]$TestDir)
$ErrorActionPreference = 'Stop'
$ExtDir = $RepoDir; $DataDir = Join-Path $TestDir 'data'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, UIAutomationClient, UIAutomationTypes
. (Join-Path $RepoDir 'pet-data.ps1')
function Assert-True($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
Initialize-PetData
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
