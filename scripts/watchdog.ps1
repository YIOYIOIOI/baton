# Baton 的看门狗：守护进程和隧道掉了就拉起来。
#
# 由「启动」文件夹里的 Baton Watchdog.lnk 在登录时拉起（scripts/install-autostart.ps1
# 一并装它）。start-daemon.ps1 起来时发现它没在跑，也会把它拉起来——两边互相兜底。
#
# ## 为什么要它
#
# start-daemon.ps1 的外层循环只管「node 退出了」。2026-11-04 22:25 之后某个时刻，
# **node 和外层那个 pwsh 一起没了**：日志里没有外层循环本该写的那句「守护进程退出了」，
# 它连写的机会都没有。整棵树被结束，循环救不了自己，直到 11-06 有人打开手机才发现。
#
# 那棵树是我（agent）11-03 从 Claude Code 的终端里重启出来的：它挂在 VS Code 的进程树
# 和作业对象下面，日志第二行「已清掉继承来的 CLAUDE_CODE_SESSION_ID …」就是印记。
# 到底是谁结束了它没查到（没有崩溃事件、没有重启、别的 agent 会话也没执行过结束进程的
# 命令；实测 `claude -p` 退出不会带走它 Start-Process 出去的进程）。查不到原因，就
# 不赌它不会再来——这里只管「掉了就拉起来」。
#
# ## 怎么拉：经 explorer 打开自启快捷方式
#
# 不直接 Start-Process start-daemon.ps1：那样拉起来的东西是**看门狗的子孙**，看门狗
# 被连根结束时它也跟着走——正是要防的那种事。让 explorer 去打开 .lnk，新进程挂在
# explorer 下面，和开机自启时一模一样。
#
# ## 判据
#
# - 端口没人听：连续 2 次（约 1 分钟）才动手，给刚开机、外层循环正在退避重启留余地。
#   外层 pwsh 还在就再多等：它可能正在退避（最长 60 秒）
# - 端口在听、但 /api/health 连续 4 次不回（约 2 分钟）：判为卡死，只结束 node，
#   让外层循环拉新的。**回 401 也算活着**——那是认证在拦，说明它在处理请求
# - 隧道：若配置了 tunnelShortcut / BATON_TUNNEL_LNK（或启动文件夹中存在 *Tunnel*.lnk），
#   检测到无匹配的 cloudflared 隧道进程连续 2 次时经该快捷方式拉起
#
# 一小时内拉起超过 5 次就降到每 10 分钟最多一次：多半是配置或代码坏了，拉也白拉，
# 别把日志刷满。日志在 ~/.baton/watchdog.log，只记状态变化，不记每次心跳。
#
# 单实例：命名互斥量。重复双击快捷方式、或者 start-daemon 和自启同时拉它，都只会留一个。
#
# 只检查一次、不动手：pwsh -NoProfile -File scripts\watchdog.ps1 -Check

param(
  [int]$IntervalSec = 30,
  [switch]$Check
)

$ErrorActionPreference = 'Continue'

$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'windows-supervision.ps1')
$dataDir = if ($env:BATON_DIR) { $env:BATON_DIR } else { Join-Path $env:USERPROFILE '.baton' }
$wrapperRecord = Join-Path $dataDir 'daemon-wrapper.json'
$nodeRecord = Join-Path $dataDir 'daemon-process.json'
$wrapperEntry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'start-daemon.ps1'))
$nodeEntry = [IO.Path]::GetFullPath((Join-Path $repo 'src/cli.js'))
$startup = [Environment]::GetFolderPath('Startup')
$daemonLnk = Join-Path $startup 'Baton.cmd'
if (!(Test-Path -LiteralPath $daemonLnk)) { $daemonLnk = Join-Path $startup 'Baton Daemon.lnk' }
$log = Join-Path $dataDir 'watchdog.log'

function LoadCfg {
  try {
    return (Get-Content (Join-Path $dataDir 'config.json') -Raw -ErrorAction Stop | ConvertFrom-Json)
  } catch {
    return $null
  }
}

$cfg = LoadCfg
$tunnelLnk = if ($env:BATON_TUNNEL_LNK) {
  $env:BATON_TUNNEL_LNK
} elseif ($cfg -and $cfg.tunnelShortcut) {
  $cfg.tunnelShortcut
} else {
  (Get-ChildItem -Path $startup -Filter '*Tunnel*.lnk' -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
}
$tunnelPattern = if ($env:BATON_TUNNEL_MATCH) {
  $env:BATON_TUNNEL_MATCH
} elseif ($cfg -and $cfg.tunnelProcessPattern) {
  $cfg.tunnelProcessPattern
} else {
  'cloudflared.*tunnel.*run'
}

function CurrentEndpoint($wrapper) {
  if ($wrapper) { return Resolve-BatonEndpoint $wrapper.Record.port $wrapper.Record.address $null }
  $daemon = Get-BatonOwnedProcess $nodeRecord $nodeEntry
  if ($daemon) {
    try { return Resolve-BatonEndpoint $daemon.Record.port $daemon.Record.address $null } finally { $daemon.Process.Dispose() }
  }
  return Resolve-BatonEndpoint 0 '' (LoadCfg)
}

function ProbeHost([string]$address) {
  $clean = $address.Trim().Trim('[', ']')
  if ($clean -eq '0.0.0.0' -or !$clean) { return '127.0.0.1' }
  if ($clean -eq '::') { return '[::1]' }
  if ($clean.Contains(':')) { return "[$clean]" }
  return $clean
}

function Note($msg) {
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  # 超过 512 KB 就挪成 .prev 重新开一份：只记状态变化，正常一年也到不了，到了说明在反复出事
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 512KB) {
    Move-Item -Force $log (Join-Path $dataDir 'watchdog.prev.log')
  }
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -FilePath $log -Append -Encoding utf8
}

function Listener($port) {
  (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
}

# 认的是 X-Baton 头，不是状态码：401 也是活着；而端口被别的东西占了时它不会带这个头
function Healthy($port, $address) {
  try {
    $h = ProbeHost $address
    $r = Invoke-WebRequest "http://${h}:$port/api/health" -TimeoutSec 5 -SkipHttpErrorCheck -ErrorAction Stop
    return [bool]$r.Headers['X-Baton']
  } catch {
    return $false
  }
}

function Running($pattern) {
  [bool](Get-CimInstance Win32_Process -Filter "Name='pwsh.exe' OR Name='cloudflared.exe'" |
    Where-Object { $_.CommandLine -match $pattern })
}

function Launch($lnk) {
  # 经 explorer 打开，新进程挂在 explorer 下面，不是看门狗的子孙（见抬头）
  Start-Process explorer.exe -ArgumentList "`"$lnk`""
}

if ($Check) {
  $wrapper = Get-BatonOwnedProcess $wrapperRecord $wrapperEntry -Wrapper
  $endpoint = CurrentEndpoint $wrapper
  $port = $endpoint.Port
  "端口 $port 有人听: $([bool](Listener $port))"
  "/api/health 带 X-Baton: $(Healthy $port $endpoint.Address)"
  "start-daemon.ps1 在跑: $([bool]$wrapper)"
  if ($wrapper) { $wrapper.Process.Dispose() }
  if ($tunnelLnk) { "隧道进程匹配 ($tunnelPattern): $(Running $tunnelPattern)" }
  exit 0
}

$mutex = [Threading.Mutex]::new($false, 'Local\BatonWatchdog')
if (-not $mutex.WaitOne(0)) { exit 0 }

Note "看门狗启动（每 $IntervalSec 秒查一次）"
# 刚登录时守护进程和隧道也在起，先等一轮再查
Start-Sleep -Seconds $IntervalSec

$down = 0; $hung = 0; $tunnelDown = 0
$script:launches = @()
$lastState = 'ok'

function MayLaunch {
  $hour = (Get-Date).AddHours(-1)
  $script:launches = @($script:launches | Where-Object { $_ -gt $hour })
  if ($script:launches.Count -lt 5) { return $true }
  # 一小时内已经拉了 5 次：每 10 分钟最多再试一次
  return ((Get-Date) - $script:launches[-1]).TotalMinutes -ge 10
}

while ($true) {
  $wrapper = Get-BatonOwnedProcess $wrapperRecord $wrapperEntry -Wrapper
  $endpoint = CurrentEndpoint $wrapper
  $port = $endpoint.Port
  $listenerId = Listener $port

  if (-not $listenerId) {
    $hung = 0
    $down += 1
    # 外层循环还在：它可能在退避重启，多给它两轮
    $need = if ($wrapper) { 4 } else { 2 }
    if ($down -ge $need) {
      if (MayLaunch) {
        if ($wrapper) {
          Note "端口 $port 已连续 $down 次没人听，外层循环还在却没把它拉起来——结束外层循环，重新拉"
          try { $wrapper.Process.Kill() } catch { Note "外层循环已退出或无法终止。" }
        } else {
          Note "端口 $port 已连续 $down 次没人听，守护进程不在——经 Baton Daemon.lnk 拉起"
        }
        if (Test-Path $daemonLnk) { Launch $daemonLnk; $script:launches += Get-Date }
        else { Note "找不到 $daemonLnk，没法拉。跑一次 scripts\install-autostart.ps1" }
        $down = 0
        $lastState = 'relaunched'
      } elseif ($lastState -ne 'backoff') {
        Note '一小时内已经拉起 5 次仍然起不来，降到每 10 分钟试一次。看 daemon.out.log 里的报错'
        $lastState = 'backoff'
      }
    }
  } elseif (-not (Healthy $port $endpoint.Address)) {
    $down = 0
    $hung += 1
    if ($hung -ge 4) {
      $owned = Get-BatonOwnedProcess $nodeRecord $nodeEntry -ListenerId $listenerId
      if ($owned) {
        Note "端口 $port 有人听（pid $listenerId），但 /api/health 连续 $hung 次不回——判为卡死，结束 node，交给外层循环重启"
        try { $owned.Process.Kill() } catch { Note "守护进程已退出或无法终止。" } finally { $owned.Process.Dispose() }
        $lastState = 'killed-hung'
      } elseif ($lastState -ne 'foreign') {
        Note "端口 $port 被别的程序占着（pid $listenerId，不是 Baton 的 node），不动它。Baton 起不来，得人来腾端口"
        $lastState = 'foreign'
      }
      $hung = 0
    }
  } else {
    if ($lastState -ne 'ok') { Note "守护进程正常（pid $listenerId）" }
    $down = 0; $hung = 0; $lastState = 'ok'
  }

  if ($wrapper) { $wrapper.Process.Dispose() }
  if ($tunnelLnk -and (Test-Path $tunnelLnk)) {
    if (Running $tunnelPattern) {
      if ($tunnelDown -ge 2) { Note '隧道连接器回来了' }
      $tunnelDown = 0
    } else {
      $tunnelDown += 1
      if ($tunnelDown -eq 2) {
        Note "没有匹配的隧道进程——经 $(Split-Path -Leaf $tunnelLnk) 拉起"
        Launch $tunnelLnk
      } elseif ($tunnelDown -gt 2 -and $tunnelDown % 20 -eq 0) {
        # 拉过了还是没有：每 10 分钟再试一次，同时留一句话
        Note "隧道连接器仍然不在（已 $tunnelDown 轮），再拉一次"
        Launch $tunnelLnk
      }
    }
  }

  Start-Sleep -Seconds $IntervalSec
}
