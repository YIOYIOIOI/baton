# Shared by the Windows launcher and watchdog. Loading these functions performs no probes.
function Resolve-BatonEndpoint([ValidateRange(0, 65535)][int]$RequestedPort = 0, [string]$RequestedHost, $Config) {
  $portNumber = $RequestedPort
  if ($portNumber -eq 0) {
    if (![int]::TryParse([string]$Config.port, [ref]$portNumber) -or $portNumber -lt 1 -or $portNumber -gt 65535) {
      $portNumber = 3002
    }
  }
  $address = if ($RequestedHost) { $RequestedHost } elseif ($Config.host) { [string]$Config.host } else { '127.0.0.1' }
  [pscustomobject]@{ Port = $portNumber; Address = $address }
}

function Get-BatonStartArguments([string]$EntryPath, $Endpoint, [switch]$ReadOnly) {
  @($EntryPath, 'start', '--port', [string]$Endpoint.Port, '--host', $Endpoint.Address)
  if ($ReadOnly) { '--read-only' }
}

function Write-BatonProcessRecord([string]$RecordPath, [int]$ProcessId, [string]$EntryPath, [int]$Port, [string]$Address) {
  $proc = Get-Process -Id $ProcessId -ErrorAction Stop
  $temp = "$RecordPath.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    $record = @{
      pid = $proc.Id
      started = $proc.StartTime.ToUniversalTime().Ticks.ToString()
      executable = $proc.Path
      entry = [IO.Path]::GetFullPath($EntryPath)
      port = $Port
      address = $Address
    }
    [IO.File]::WriteAllText($temp, ($record | ConvertTo-Json -Compress))
    [IO.File]::Move($temp, $RecordPath, $true)
  } finally {
    $proc.Dispose()
    [IO.File]::Delete($temp)
  }
}

function Test-BatonProcessIdentity($Record, [int]$ProcessId, [string]$Started, [string]$Executable, [string]$CommandLine, [string]$EntryPath, [switch]$Wrapper) {
  if (!$Record -or $Record.pid -ne $ProcessId -or [string]$Record.started -cne $Started) { return $false }
  $equal = [StringComparer]::OrdinalIgnoreCase
  $image = if ($Wrapper) { 'pwsh.exe' } else { 'node.exe' }
  if (!$equal.Equals([IO.Path]::GetFileName($Executable), $image) -or !$equal.Equals($Record.executable, $Executable)) { return $false }
  if (![IO.Path]::IsPathFullyQualified($EntryPath)) { return $false }
  $expected = [IO.Path]::GetFullPath($EntryPath)
  if (!$equal.Equals($Record.entry, $expected)) { return $false }

  # Read only the script argument in the registered node or pwsh invocation.
  $prefix = '^\s*(?:"[^"]+"|[^\s"]+)\s+'
  if ($Wrapper) { $prefix += '(?:(?:-NoProfile|-NoLogo|-NonInteractive|-ExecutionPolicy\s+\w+|-WindowStyle\s+\w+)\s+)*-File\s+' }
  if ($CommandLine.Replace('/', '\') -notmatch ($prefix + '(?:"(?<entry>[^"]+)"|(?<entry>[^\s"]+))(?:\s|$)')) { return $false }
  $argument = $Matches.entry
  if ($equal.Equals($expected, $argument)) { return $true }
  if (![IO.Path]::IsPathFullyQualified($argument)) { return $false }

  # A command can mix long and DOS names. Ask Windows for the registered file's
  # short names so an unrelated junction pointing at this installation cannot match.
  try { $short = (New-Object -ComObject Scripting.FileSystemObject -ErrorAction Stop).GetFile($expected).ShortPath }
  catch { return $false }
  $longParts = $expected.Split('\')
  $shortParts = $short.Split('\')
  $actualParts = $argument.Split('\')
  if ($actualParts.Count -ne $longParts.Count -or $shortParts.Count -ne $longParts.Count) { return $false }
  for ($i = 0; $i -lt $longParts.Count; $i++) {
    if (!$equal.Equals($actualParts[$i], $longParts[$i]) -and !$equal.Equals($actualParts[$i], $shortParts[$i])) { return $false }
  }
  return $true
}

function Get-BatonOwnedProcess([string]$RecordPath, [string]$EntryPath, [int]$ListenerId = 0, [switch]$Wrapper) {
  $proc = $null
  try {
    $record = [IO.File]::ReadAllText($RecordPath) | ConvertFrom-Json -ErrorAction Stop
    if ($record.pid -le 0 -or ($ListenerId -gt 0 -and $record.pid -ne $ListenerId)) { return $null }
    $proc = Get-Process -Id $record.pid -ErrorAction Stop
    # Pin this OS process before checking its identity. Recovery uses this handle, not a fresh PID lookup.
    $null = $proc.SafeHandle
    $command = (Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.Id)" -ErrorAction Stop).CommandLine
    $started = $proc.StartTime.ToUniversalTime().Ticks.ToString()
    if (!(Test-BatonProcessIdentity $record $proc.Id $started $proc.Path $command $EntryPath -Wrapper:$Wrapper)) { return $null }
    $owned = [pscustomobject]@{ Process = $proc; Record = $record }
    $proc = $null
    return $owned
  } catch {
    return $null
  } finally {
    if ($proc) { $proc.Dispose() }
  }
}
