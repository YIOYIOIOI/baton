param([switch]$LoginEnvironment)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$packages = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages'
$desktop = Get-ItemProperty "$packages\OpenAI.Codex_*__2p2nqsd0c76g0" -Name PackageRootFolder -ErrorAction SilentlyContinue |
  Sort-Object { [version]($_.PSChildName.Split('_')[1]) } -Descending |
  ForEach-Object { Join-Path $_.PackageRootFolder 'app/resources/codex.exe' } |
  Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

$variables = @{}
if ($LoginEnvironment) {
  $machine = [Environment]::GetEnvironmentVariables('Machine')
  $user = [Environment]::GetEnvironmentVariables('User')
  foreach ($name in @($machine.Keys) + @($user.Keys)) {
    if ($name -match '^(OPENAI_|CODEX_)') {
      $variables[$name] = $user[$name] ?? $machine[$name]
    }
  }
  $config = Join-Path ($variables['CODEX_HOME'] ?? (Join-Path $HOME '.codex')) 'config.toml'
  if (Test-Path -LiteralPath $config -PathType Leaf) {
    foreach ($line in [IO.File]::ReadLines($config)) {
      if ($line -match '^\s*env_key\s*=\s*["'']([A-Za-z_][A-Za-z0-9_]*)["'']') {
        $name = $Matches[1]
        $variables[$name] = $user[$name] ?? $machine[$name]
      }
    }
  }
}
@{ desktop = $desktop; variables = $variables } | ConvertTo-Json -Compress
