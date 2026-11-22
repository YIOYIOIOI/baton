param([int]$NodeId, [string]$DataDir, [string]$EntryPath, [int]$Port, [string]$Address)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-supervision.ps1')
Write-BatonProcessRecord (Join-Path $DataDir 'daemon-process.json') $NodeId $EntryPath $Port $Address
