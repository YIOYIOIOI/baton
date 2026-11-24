param([string]$Scripts, [string]$Fixture, [string]$Node)
$ErrorActionPreference = 'Stop'
. (Join-Path $Scripts 'windows-supervision.ps1')

function Assert-True($Value, [string]$Message) { if (!$Value) { throw $Message } }
function Start-FixtureProcess([string]$Executable, [string[]]$Arguments) {
  $info = [Diagnostics.ProcessStartInfo]::new($Executable)
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  foreach ($arg in $Arguments) { $info.ArgumentList.Add($arg) }
  [Diagnostics.Process]::Start($info)
}

function Wait-FixtureReady([string]$Entry, [Diagnostics.Process]$Child) {
  $until = [DateTime]::UtcNow.AddSeconds(10)
  while (-not [IO.File]::Exists("$Entry.ready")) {
    if ($Child.HasExited -or [DateTime]::UtcNow -ge $until) { throw 'Registered-process fixture did not start' }
    Start-Sleep -Milliseconds 50
  }
}

$endpoint = Resolve-BatonEndpoint 42143 '::1' @{ port = 42001; host = '127.0.0.1' }
Assert-True ($endpoint.Port -eq 42143 -and $endpoint.Address -eq '::1') 'Explicit endpoint lost'
Assert-True ((Resolve-BatonEndpoint 0 '' @{ port = 42001 }).Port -eq 42001) 'Config endpoint lost'
Assert-True ((Resolve-BatonEndpoint 0 '' $null).Port -eq 3002) 'Default endpoint lost'
Assert-True ((Resolve-BatonEndpoint 0 '' @{ port = 'invalid' }).Port -eq 3002) 'Invalid config port did not fall back'

$ownDir = [IO.Directory]::CreateDirectory((Join-Path $Fixture 'our install/src')).FullName
$otherDir = [IO.Directory]::CreateDirectory((Join-Path $Fixture 'other install/src')).FullName
$entry = Join-Path $ownDir 'cli.js'
$otherEntry = Join-Path $otherDir 'cli.js'
foreach ($file in @($entry, $otherEntry)) { [IO.File]::WriteAllText($file, 'require("node:fs").writeFileSync(__filename + ".ready", "1"); setInterval(() => {}, 60000);') }
$nodeArgs = @(Get-BatonStartArguments $entry $endpoint -ReadOnly)
Assert-True (($nodeArgs -join '|') -ceq "$entry|start|--port|42143|--host|::1|--read-only") 'Wrong startup argv'
$recordPath = Join-Path $Fixture 'daemon-process.json'
$wrapperPath = Join-Path $Fixture 'our install/start-daemon.ps1'
[IO.File]::WriteAllText($wrapperPath, '[IO.File]::WriteAllText("$PSCommandPath.ready", "1"); Start-Sleep -Seconds 45')
$fileSystem = New-Object -ComObject Scripting.FileSystemObject
# A launcher can use the DOS spelling of just the parent, leaving the script name long.
$wrapperArg = Join-Path ($fileSystem.GetFolder((Split-Path -Parent $wrapperPath)).ShortPath) 'start-daemon.ps1'
$otherArg = $fileSystem.GetFile($otherEntry).ShortPath
$processes = @()
try {
  $own = Start-FixtureProcess $Node $nodeArgs
  $processes += $own
  $other = Start-FixtureProcess $Node @($otherArg, $entry)
  $processes += $other
  $wrapper = Start-FixtureProcess (Join-Path $PSHOME 'pwsh.exe') @('-NoProfile','-File',$wrapperArg)
  $processes += $wrapper
  Wait-FixtureReady $entry $own
  Wait-FixtureReady $otherEntry $other
  Wait-FixtureReady $wrapperPath $wrapper
  $wrapperRecord = Join-Path $Fixture 'daemon-wrapper.json'
  Write-BatonProcessRecord $wrapperRecord $wrapper.Id $wrapperArg 42143 '::1'
  $held = Get-BatonOwnedProcess $wrapperRecord $wrapperPath -Wrapper
  Assert-True ($null -ne $held -and $held.Record.port -eq 42143) 'Managed wrapper launched through its DOS path was not recognized'
  $linkedInstall = New-Item -ItemType Junction -Path (Join-Path $Fixture 'linked install') -Target (Split-Path -Parent $wrapperPath)
  $record = $held.Record
  $linkedCommand = '"{0}" -File "{1}"' -f $record.executable, (Join-Path $linkedInstall.FullName 'start-daemon.ps1')
  Assert-True (!(Test-BatonProcessIdentity $record $wrapper.Id $record.started $record.executable $linkedCommand $wrapperPath -Wrapper)) 'A different junction to the wrapper matched'
  $held.Process.Dispose()

  & (Join-Path $Scripts 'register-daemon.ps1') -NodeId $own.Id -DataDir $Fixture -EntryPath $entry -Port 42143 -Address '::1'
  Assert-True ($null -eq (Get-BatonOwnedProcess $recordPath $entry -ListenerId $other.Id)) 'Foreign listener matched'
  $original = [IO.File]::ReadAllText($recordPath)
  $altered = $original | ConvertFrom-Json
  $altered.started = '1'
  [IO.File]::WriteAllText($recordPath, ($altered | ConvertTo-Json))
  Assert-True ($null -eq (Get-BatonOwnedProcess $recordPath $entry -ListenerId $own.Id)) 'Reused PID matched'
  Write-BatonProcessRecord $recordPath $other.Id $entry 42143 '::1'
  Assert-True ($null -eq (Get-BatonOwnedProcess $recordPath $entry -ListenerId $other.Id)) 'DOS path of an unrelated src/cli.js matched'
  [IO.File]::WriteAllText($recordPath, $original)
  $held = Get-BatonOwnedProcess $recordPath $entry -ListenerId $own.Id
  Assert-True ($null -ne $held) 'Managed node was not recognized'
  $held.Process.Kill()
  $held.Process.Dispose()
  Assert-True ($own.WaitForExit(5000) -and !$other.HasExited) 'Recovery affected wrong process'
} finally {
  foreach ($child in $processes) {
    if (!$child.HasExited) { $child.Kill(); $child.WaitForExit() }
    $child.Dispose()
  }
}
