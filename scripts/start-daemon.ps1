# 启动 Baton 守护进程，并确保它拿到用户级环境变量。
#
# 由「启动」文件夹里的 Baton Daemon.lnk 在登录时拉起（scripts/install-autostart.ps1
# 负责建那个快捷方式）。也可以手动跑：
#
#   pwsh -NoProfile -File <repo>\scripts\start-daemon.ps1
#
# ## 为什么要显式注入环境变量
#
# 凭据（ANTHROPIC_AUTH_TOKEN 等）可能由供应商切换工具写在**用户级**环境变量里。一个进程
# 拿不拿得到它们，取决于**是谁把它拉起来的**：Claude Code 派生的 shell 会专门剥掉
# ANTHROPIC_AUTH_TOKEN（docs/ops/agent-protocol.md §6），而剥掉之后 Baton 照样起得来、
# 只是每一轮 Claude 都以 Not logged in 失败——报错只在手机上看得见。
#
# 这只是第三方 API 中转那一路。用账号登录（/login）时凭据在本地配置文件/Keychain，
# 用户级环境变量里没有 ANTHROPIC_*，这里也就不注入——**而只要注入了，就是它说了算**：
# 环境变量里的 token 优先于账号登录（agent-protocol §12）。Codex 每次启动子进程时
# 重读登录环境；Claude 的环境变量仍取这个脚本启动时的值。
#
# 旧的启动方式（scripts/baton-start.cmd，2026-09-28 删除）依赖继承。它在 ~/.baton/
# daemon.log 里留下的两次启动记录**都缺这个变量**。这里改成从注册表的用户作用域
# 显式读一遍再注入，于是不管从哪儿拉起来都一样。
#
# ## 为什么这份在仓库里
#
# 2026-09-28 之前它只存在于 ~/.baton/start-daemon.ps1，不进版本控制；而仓库里
# install-autostart.ps1 装的是另一套（上面那个 .cmd）。两套并存，真正在用的那套
# 反而没人能 review。现在只有这一份。
#
# ## agent 那几族变量只认登录环境，不认继承
#
# 2026-10-01 起。上面说的是「少了」，还有「多了」这一头：09-29 那次是从桌面 App
# 的 agent 终端里重启的，守护进程把桌面 App 给**它自己的会话**设的那一整套变量
# 都继承了下来（CLAUDE_CODE_ENTRYPOINT=claude-desktop-3p、CLAUDE_EFFORT=max、
# CLAUDE_CODE_HOST_SESSION_ID…），再原样传给 Baton 起的每一轮：transcript 里全记成
# 桌面会话，没选强度的轮次也被悄悄钉成了 max。于是「默认是什么模型、什么强度」
# 取决于是谁把守护进程拉起来的。
#
# 所以这几族（ANTHROPIC_* / CLAUDE* / _CLAUDE_CODE_* / CODEX_* / OPENAI_*）一律
# 按注册表重建：用户级有就用用户级，其次系统级，都没有就删掉。结果和登录后
# 自启拉起来的那一份一样，不管从哪儿重启。代价：在终端里临时 $env: 设的这几族
# 变量不会带进守护进程——要长期生效就写进用户级环境变量。
#
# 只看会做什么、不启动：pwsh -NoProfile -File scripts\start-daemon.ps1 -DryRun
# （只列变量名，不打印值）

param([switch]$DryRun, [ValidateRange(0, 65535)][int]$Port = 0, [string]$HostAddr = '', [switch]$ReadOnly)

$ErrorActionPreference = 'Stop'

# 仓库根 = 本脚本所在目录的上一级。不写死路径：仓库挪了位置照样能用
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'windows-supervision.ps1')

$family = '^(ANTHROPIC_|CLAUDE|_CLAUDE_CODE_|CODEX_|OPENAI_|ANTIGRAVITY_|AGY_)'
$names = @(
  @(Get-ChildItem Env: | ForEach-Object Name) +
  @([Environment]::GetEnvironmentVariables('User').Keys) +
  @([Environment]::GetEnvironmentVariables('Machine').Keys) |
    Where-Object { $_ -match $family } | Sort-Object -Unique
)

$loaded = @(); $loadedMachine = @(); $dropped = @()
foreach ($n in $names) {
  $v = [Environment]::GetEnvironmentVariable($n, 'User')
  $from = 'User'
  if (-not $v) { $v = [Environment]::GetEnvironmentVariable($n, 'Machine'); $from = 'Machine' }
  if ($v) {
    Set-Item -Path "Env:$n" -Value $v
    if ($from -eq 'User') { $loaded += $n } else { $loadedMachine += $n }
  } elseif (Test-Path "Env:$n") {
    Remove-Item -Path "Env:$n"
    $dropped += $n
  }
}

if ($DryRun) {
  "注入（用户级）: $($loaded -join ', ')"
  "注入（系统级）: $($loadedMachine -join ', ')"
  "清掉（继承来的）: $($dropped -join ', ')"
  exit 0
}

# 数据目录与端口跟守护进程读的是同一份（BATON_DIR 可覆盖，端口看 config.json）
$dataDir = if ($env:BATON_DIR) { $env:BATON_DIR } else { Join-Path $env:USERPROFILE '.baton' }
$dataDir = [IO.Path]::GetFullPath($dataDir)
$cfg = $null
try {
  $cfg = Get-Content (Join-Path $dataDir 'config.json') -Raw -ErrorAction Stop | ConvertFrom-Json
} catch {
  # 没有或坏了：守护进程自己也会退回默认 3002
}
$endpoint = Resolve-BatonEndpoint $Port $HostAddr $cfg
$effectivePort = $endpoint.Port

function Listening { [bool](Get-NetTCPConnection -LocalPort $effectivePort -State Listen -ErrorAction SilentlyContinue) }

# 看门狗（watchdog.ps1）没在跑就把它拉起来：它管守护进程，守护进程每次起来时管它，互相兜底。
# 放在「已经有一个在跑」的判断之前：守护进程好好的、看门狗却没了，也该补上。
# 经 explorer 打开它的快捷方式——直接 Start-Process 的话它成了这个脚本的子孙，这棵树被
# 连根结束时（2026-11 就出过一次，见 watchdog.ps1 抬头）它也跟着走。
$watchdogLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Baton Watchdog.lnk'
$watchdog = 'absent'
if (Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" | Where-Object { $_.CommandLine -match 'watchdog\.ps1' }) {
  $watchdog = 'running'
} elseif (Test-Path $watchdogLnk) {
  Start-Process explorer.exe -ArgumentList "`"$watchdogLnk`""
  $watchdog = 'started'
}

# 已经有一个在跑了就什么都不做。**必须在碰日志之前判**：否则第二个会把第一个正在
# 写的日志挪走。重复双击快捷方式、或者自启时手动开着的那个还在，都会走到这里。
if (Listening) {
  Write-Host "  端口 $effectivePort 已有进程监听，跳过启动。"
  exit 0
}

# 留一份启动日志。
#
# 自启时窗口是隐藏的，横幅会直接消失。而「重启之后它到底起没起、凭据拿到没有」
# 正是每次都要问的两个问题，没有日志就只能靠猜。
#
# 显式写文件而不是靠重定向：Write-Host 走的是信息流，`2>&1` **捕获不到**，
# 那条「已注入哪些环境变量」就会从日志里消失——而它恰恰是最要紧的一行。
#
# **上一次的日志留一份**（daemon.out.prev.log）。原来每次启动都截断重写：守护进程
# 崩了、有人手动重启之后，崩溃时的那段报错就没了——而那正是最需要看的时候。
$log = Join-Path $dataDir 'daemon.out.log'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
if (Test-Path $log) { Move-Item -Force $log (Join-Path $dataDir 'daemon.out.prev.log') }

function Note($msg) {
  $line = "  $msg"
  Write-Host $line -ForegroundColor DarkGray
  $line | Out-File -FilePath $log -Append -Encoding utf8
}

"=== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 启动 ===" |
  Out-File -FilePath $log -Append -Encoding utf8

Note "已注入用户级环境变量: $($loaded -join ', ')"
if ($loadedMachine) { Note "已注入系统级环境变量: $($loadedMachine -join ', ')" }
# 非空就说明是从别的 agent 里重启的——自启拉起来时这一行不会出现
if ($dropped) { Note "已清掉继承来的: $($dropped -join ', ')" }
# 账号登录（/login）时凭据在 ~/.claude/.credentials.json，环境变量里本来就没有
$loggedIn = Test-Path (Join-Path $env:USERPROFILE '.claude\.credentials.json')
if ($loaded -contains 'ANTHROPIC_AUTH_TOKEN') {
  Note "Claude 凭据: 环境变量（中转 $env:ANTHROPIC_BASE_URL）$(if ($loggedIn) { '——账号登录也在，但环境变量优先' })"
} elseif ($loggedIn) {
  Note 'Claude 凭据: 账号登录（~/.claude/.credentials.json）'
} else {
  # 两样都没有 Baton 也起得来，但 Claude 那边发不出消息，而且报错只在手机上看得见
  Note '⚠ 没拿到 ANTHROPIC_AUTH_TOKEN，电脑上也没登录账号 —— Claude 会话将无法认证。'
}
Note "工作目录: $repo"
Note ("看门狗: " + @{ running = '已在跑'; started = '刚拉起'; absent = '没装（跑一次 scripts\install-autostart.ps1）' }[$watchdog])

# node 按 UTF-8 输出，而 PowerShell 默认拿控制台代码页（本机是 cp936）去解它，
# 于是横幅在日志里全是乱码。把控制台输出编码对齐到 UTF-8 再跑。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Set-Location $repo

# 外层循环：守护进程退出了就重新拉起来。
#
# 原来跑一次就完，守护进程一退（2026-10-01 审查复现过三种一个请求就打挂的情况），
# 就一直停着，直到有人发现、手动重启——而这台电脑常常没人在跟前。
#
# 三种情况不再拉：
#   - 端口已经被别的进程占了：多半是另一个守护进程，不跟它抢
#   - 连续 5 次起来不到 30 秒就退：多半是配置或代码坏了，再拉也是白拉，
#     留着日志给人看
#   - 这个脚本本身被杀掉了：要真的停掉 Baton，先杀这个 pwsh，再杀 node
#
# **要重启守护进程（比如更新了代码）：只杀 node 那个进程**，这里会在一两秒内拉起新的。
$env:BATON_CODEX_LOGIN_ENV = '1'
$env:BATON_DIR = $dataDir
$env:BATON_WATCHDOG_MANAGED = '1'
try { Write-BatonProcessRecord (Join-Path $dataDir 'daemon-wrapper.json') $PID $PSCommandPath $effectivePort $endpoint.Address }
catch { Note '无法登记启动进程，看门狗将跳过对它的终止操作。' }
$cliArgs = @(Get-BatonStartArguments (Join-Path $repo 'src/cli.js') $endpoint -ReadOnly:$ReadOnly)

$fast = 0
$round = 0
while ($true) {
  $round += 1
  if ($round -gt 1) { "=== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 重启（第 $round 次） ===" | Out-File -FilePath $log -Append -Encoding utf8 }
  $t0 = Get-Date
  # *>&1 而不是 2>&1：要把所有流（含 npm/node 写到主机流的东西）都收进日志
  & node @cliArgs *>&1 | Out-File -FilePath $log -Append -Encoding utf8
  $code = $LASTEXITCODE
  $ran = [int]((Get-Date) - $t0).TotalSeconds

  if (Listening) { Note "守护进程退出了（退出码 $code），但端口 $effectivePort 已被占用，停止重启。"; break }
  if ($ran -lt 30) { $fast += 1 } else { $fast = 0 }
  if ($fast -ge 5) { Note "守护进程连续 5 次起来不到 30 秒就退出，停止自动重启。看上面的报错。"; break }
  $wait = [Math]::Min(60, [Math]::Pow(2, $fast))
  Note "守护进程退出了（退出码 $code，跑了 $ran 秒），$wait 秒后重启。"
  Start-Sleep -Seconds $wait
}
