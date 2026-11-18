# agent 非交互协议实测

> 2026-09-10 本机实测。夹具见 `test/fixtures/claude-stream-json.jsonl`、`test/fixtures/codex-exec-json.jsonl`。
> 两个 CLI 的输出 schema 都没有公开文档，**照猜写的解析器会静默错**——本文档记录实测到的字段名与三个陷阱。

## 0. 做协议探测时不要污染真实会话目录

2026-09-10 的那次探测在 `~/.claude/projects/C--workspace-baton-probe/` 留下 4 个 transcript、在 `~/.codex/sessions/` 留下 1 个 rollout，它们**出现在了本地的真实会话列表里**（已清理，备份在 `/tmp/baton-probe-artifacts/`）。

以后按这两条走：

| 探测类型 | 做法 |
|---|---|
| **不需要 resume** 的探测（抓输出 schema、验 stdin 编码、看错误形态） | 加 `--no-session-persistence`（Claude，仅配合 `--print`）/ `--ephemeral`（Codex）。**根本不写会话文件** |
| **需要 resume** 的探测（验「续写不分叉」这类） | 必须持久化，没有别的办法。用专门的探测目录，并把**删除 transcript 与 rollout 写进探测任务本身的收尾步骤**——不是「记得删」，是任务的一个步骤 |

`--no-session-persistence` 的说明写着「sessions will not be saved to disk and cannot be resumed」，所以它和 resume 类探测互斥，这就是上面要分两档的原因。

## 1. 启动方式

两侧都确认：**消息可经 stdin 传入**，不必进 argv。

```
claude -p --output-format stream-json --verbose        # 消息写 stdin
codex exec --json [--skip-git-repo-check]              # 消息写 stdin，stderr 会打印 "Reading prompt from stdin..."
```

Node 侧用 `child.stdin.end(message, 'utf8')` 显式 UTF-8 写入。**中文往返实测完好**（发「请原样重复：接力棒已就位」，两侧都原样返回）。

> 用 PowerShell 管道传中文会被代码页打成 `????`。那是 shell 外壳的问题，不是机制问题——Node 显式 UTF-8 写入没有这个问题。测试时别用 shell 管道验证编码。

`spawn(..., { shell: true })` 在 Windows 上是必需的（`claude` / `codex` 是 `.cmd` 包装，Node 自 CVE-2024-27980 起要求 `.cmd` 经 shell 启动）。Node 会就此发出 `DEP0190` 警告：**「传给 shell 的参数不转义、只拼接」**。这正是「消息必须走 stdin、argv 只放程序自控内容」这条设计的依据。

## 2. Claude：`--output-format stream-json`

一次成功调用的记录序列：

```
system/hook_response     hook_name / hook_event / exit_code / outcome
system/init              session_id / cwd / model / permissionMode / tools / ...
assistant                message / session_id / uuid / timestamp / error / is_api_error_message
result/success           is_error / usage / session_id / result / total_cost_usd / num_turns / stop_reason / duration_ms
```

| 需要的东西 | 字段 |
|---|---|
| 会话 id | `session_id`（多条记录都有，`system/init` 与 `result` 均可取） |
| token 计数 | `result.usage`（`input_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` / `output_tokens` / `output_tokens_details.thinking_tokens`） |
| 成败 | **`result.is_error`** |
| 失败原因 | `result.result`（失败时是人类可读的消息，例如 `Not logged in · Please run /login`） |

### ⚠️ 陷阱一：`subtype` 不是成败信号

失败的一轮实测为 `subtype: "success"` 但 `is_error: true`。**只能用 `is_error` 判成败。** 拿 `subtype === 'success'` 判断会把失败当成功。

### ⚠️ 陷阱二：进程退出码不可单独采信

认证失败那次退出码为 1，但输出里 `subtype` 仍是 `success`。以 `result` 记录为准，退出码只作辅助。

## 3. Codex：`exec --json`

**stdout 的 schema 与 rollout 文件完全不同。** rollout 里是 `event_msg` / `response_item` 加嵌套 `payload.type`；stdout 用点号命名的扁平结构：

```
thread.started    thread_id
turn.started      （无载荷）
error             message
item.completed    item{ id, type: 'agent_message', text }
turn.completed    usage{ input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens }
```

| 需要的东西 | 字段 |
|---|---|
| 会话 id | `thread.started.thread_id` |
| token 计数 | `turn.completed.usage` |
| 成功终态 | `turn.completed` |
| agent 正文 | `item.completed.item.text`（`item.type === 'agent_message'`） |

### ⚠️ 陷阱三：成功的一轮里也会出现 `error` 记录

实测一次**成功**的调用里包含：

```json
{"type":"error","message":"Reconnecting... 1/5 (stream disconnected before completion: ...)"}
```

这是**瞬时重连通知**，不是终态。把任何 `error` 记录当失败，会把成功轮报成失败。**终态只看 `turn.completed` 是否出现。**

### 受信任目录限制

在非 git、未登记为受信任的目录下，`codex exec` 直接拒绝启动：

```
Not inside a trusted directory and --skip-git-repo-check was not specified.
```

Baton 在白名单目录里新建 Codex 会话时会撞上这条。处置：启动参数带 `--skip-git-repo-check`。

### 技能加载噪声

stderr 会打印形如
`ERROR codex_core::session::session: failed to load skill ...: missing YAML frontmatter delimited by ---`
的行。**不影响本轮成败**，属噪声，不要据此判失败。

## 4. `codex queue` 只入队，不执行

```
codex queue --thread <id> --message <text>
→ 退出码 0，打印 "Queued message <msg-id> for thread <thread-id>."
→ rollout 文件增长 0 字节，没有进程被拉起
```

**结论：v1 不使用 `codex queue`。** Baton 是「一轮一进程」，入队的消息没有进程去消费，会变成孤儿。执行一律走 `codex exec resume <id>`。

（这关闭了设计文档 §17 已知限制第 3 条。）

## 5. `claude --resume` 原地续写，不分叉 —— 已复现

实测（会话 `f240658a-1fdb-45ed-bb3c-864f562c007a`）：

| | resume 前 | resume 后 |
|---|---|---|
| 项目目录 `.jsonl` 文件数 | 4 | **4**（未新增） |
| 目标文件字节 | 24115 | **27711**（原地追加 3596） |
| 输出里的 `session_id` | — | 与原会话**相同** |
| 上下文 | — | 准确答出上一轮内容 |

确认设计文档 §2.5 的结论。`--fork-session` 才产生新文件。

## 6. 凭据必须由环境继承 —— 对部署有硬性要求

`claude` 认证走用户级环境变量 `ANTHROPIC_AUTH_TOKEN`（例如使用第三方 API 代理或配置管理工具时）。实测：

- 用户级（注册表）：`ANTHROPIC_BASE_URL` 已设置、`ANTHROPIC_AUTH_TOKEN` 已设置
- **在 Claude Code 派生的子 shell 里：`ANTHROPIC_AUTH_TOKEN` 为空**（宿主会剥掉它，防止嵌套 agent 外泄凭据）

此时 `claude -p` 返回：

```json
{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}
```

**对 Baton 的要求**：守护进程必须拿到用户级环境变量里的凭据。

~~「启动」文件夹快捷方式或普通终端都可以~~——2026-09-28 划掉：这句当时没有实测撑着，
而依赖继承的旧启动器（`scripts/baton-start.cmd`）在 `~/.baton/daemon.log` 里留下的
两次启动记录**都缺这个变量**。能否继承取决于拉起它的宿主，赌不得。现在一律经
`scripts/start-daemon.ps1` 启动：它从注册表的用户作用域**显式**读一遍再注入。

**并且**：Baton 启动时应检查 `ANTHROPIC_AUTH_TOKEN` 是否存在，缺失就大声报错并给出修复指引——否则每一轮都会以 `Not logged in` 失败，而用户完全不知道为什么。这属于设计文档 §3 第 8 条「每个失败都必须可操作」。

Codex 的凭据在 `~/.codex/config.toml`（`experimental_bearer_token`），不依赖环境变量，故不受此影响。

## 7. `-p` 模式下没有 `AskUserQuestion`，但 MCP 工具可用且会阻塞

2026-09-24 实测，`claude` 2.1.281。

> 2026-09-24 的提交 `dfe6ca6` 里把这一节写作 §6：那是当时**插在凭据那节前面**的编号，
> 挤掉了凭据的 §6（三处引用因此断了）。2026-09-28 复位：新内容一律追加到末尾，
> 不给已有章节改号。


### 7.1 那个选项框拿不到

`system/init` 的 `tools` 表里**没有** `AskUserQuestion`（也没有 `ExitPlanMode`）。
三条独立尝试，都拿不回来：

| 做法 | 结果 |
|---|---|
| 裸跑 `claude -p --output-format stream-json --verbose` | tools 表里没有它；模型自己说「这个会话里没有 AskUserQuestion 工具，所以没法弹出选项框」 |
| `--tools Read,Write,Bash,AskUserQuestion` | CLI **静默丢掉**这个名字，实际 `TOOLS=Bash,Read,Write` |
| `--allowedTools AskUserQuestion` | tools 表原封不动，仍然没有它 |

**结论：Baton 自己跑的轮次永远不会产生 `AskUserQuestion`。** 本机 transcript 里那
167 次全部来自交互式会话（电脑上手打的那些），Baton 只是读到了同一份文件。

### 7.2 正文里认选项这条路，量过之后否掉了

在本机 17473 条 agent 正文上跑一个保守检测器（问句 + 2~6 条加粗项目符号 +
后面没有大段正文）：命中 29 条（0.17%），逐条看前 12 条，**只有 2 条是真选择题**，
其余 10 条是待办清单、注意事项、差距列表。精确率约 17%——会在普通项目符号下面
挂一排假按钮。

### 7.3 MCP 工具可用，而且**真的阻塞这一轮**

| 验的事 | 做法 | 结果 |
|---|---|---|
| 能不能用 | `--mcp-config <file>` 加一个 stdio 服务器 | tools 表里出现 `mcp__baton__ask`，`mcp_servers` 里 `{"name":"baton","status":"connected","source":"dynamic"}` |
| 阻不阻塞 | 服务器收到 `tools/call` 后睡 4 秒 | 该轮 `duration_ms = 10100` |
| 会不会超时 | 睡 75 秒 | 该轮 `duration_ms = 81433`，**不超时** |

**所以「在这一轮里等用户点选」是可行的**：挂住 MCP 那条响应就等于挂住 agent。
Baton 据此实现了 `mcp__baton__ask`（`src/ask/`）。自己的超时设 240 秒，比
`runProcess` 的整轮上限 600 秒短——超时后交回一句「没人回答」，让 agent 正常收尾，
而不是整轮被 taskkill 掉。（2026-10-01：`runProcess` 的整轮上限已撤掉，默认不限时；
240 秒这个超时照旧，理由只剩「别一直挂着等」。）

### 7.4 权限：默认档位会拒，白名单只开一个口子

判据是**磁盘副作用**，不是 agent 的说辞（同 §permission.js 抬头那条纪律）。

| 参数 | ask | Write | Bash | canary.txt | shell.txt |
|---|---|---|---|---|---|
| 默认档位（无权限参数） | **拒**（7.9 秒快速失败，不挂） | 拒 | 拒 | — | — |
| 默认档位 + `--allowedTools mcp__baton__ask` | **放行** | 拒 | 拒 | 不存在 | 不存在 |

被拒时的原话：`Claude requested permissions to use mcp__baton__ask, but you haven't
granted it yet.`

也就是说这条白名单**只开了这一个工具**，而它唯一的能力是「问用户一句话」。

### 7.5 MCP 配置里的 `env` 才是可靠的传参口

令牌没走环境变量继承：MCP 官方 SDK 拉起 stdio 服务器时用的是
`getDefaultEnvironment()`——那是一份白名单，自定义变量会不会被滤掉**没有文档保证**。
配置文件里的 `env` 字段是协议明确规定要传给子进程的，实测也确实到达。
所以 Baton 每轮写一份配置（`~/.baton/ask/<turnId>.json`，0600），跑完删掉。

### 7.6 Codex 这边做不到同样的事

`codex exec` 的 MCP 服务器配在 `~/.codex/config.toml` 里，**没有等价的
「只给这一轮加一个服务器」的命令行参数**。去改用户的全局配置不在 Baton 该做的事
情之内，所以 Codex 会话仍然只能在正文里问。这是**已知差距**，不是疏漏。

## 8. 「默认」是什么模型、什么强度：配置里推不出来，要看 CLI 发出去的请求

2026-10-01 实测，claude 2.1.281。起因是 owner 要求「默认也要显示到底是什么模型以及思考强度」。

### 8.1 三处看着像答案的地方都不是

| 地方 | 写着 | 实际 |
|---|---|---|
| `~/.claude/settings.json` 的 `effortLevel` | `"max"` | CLI 对这个键只认 `low` / `medium` / `high` / `xhigh`，认不得的值当没写（`max` 只能用在单个会话里，不会存下来） |
| 桌面 App 给自己会话设的 `CLAUDE_EFFORT` | `max` | 不生效。守护进程 09-29 至 10-01 继承了它，那几天 Baton 没选强度的轮次在 transcript 里记的全是 `medium` |
| 默认模型 | 哪个配置里都没有 | init 报 `claude-opus-5-5[1m]`，请求头带 `context-1m-2025-08-07` |

结论：**不传 `--model` / `--effort` 时是 Opus 5.5 · 1M 上下文 · medium。**

### 8.2 显式选模型会丢掉 1M

`--model claude-opus-5-5` 或 `--model opus` → init 报 `claude-opus-5-5`（没有 `[1m]`），请求头里也没有
`context-1m`。**「默认」和列表里的「Opus 5.5」不是同一档。** `/model` 列出的可选名里有 `opus[1m]`。

### 8.3 各自从哪儿读得到

| 要什么 | 在哪 | 花不花钱 |
|---|---|---|
| 默认模型 | init 记录的 `model`；或 stdin 送 `/model`（`-p` 下是本地命令）：`Current model: `` `Opus 5.5 (1M context) (default)` `` | 不花。不带凭据也行 |
| 默认强度 | init 里**没有**；`/effort` 不带参数只打印用法 | — |
| 实际用过的强度 | transcript 的 assistant 记录：`effort` = 那次请求实际用的，`perTurnEffort` = `--effort` 传进去的（没传是 null） | 不花，但要先有那一轮 |
| 默认强度（事前） | 截它发出去的第一条请求：`output_config.effort` | 不花，见下 |

### 8.4 截请求：只改环境变量会真的发出去

把 `ANTHROPIC_BASE_URL` 指到本机假端点、回 400，就能读到请求体而不出本机。**但只改进程环境不行**：
`settings.json` 的 `env` 里也写着 `ANTHROPIC_BASE_URL`，CLI 启动后拿它盖掉了进程环境里的值——
第一次试就这样真发给了中转、拿到了真回答。

要用 `--settings <文件>`（里面写 `{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:<端口>"}}`），它的优先级
比 `settings.json` 高，实测生效。另加一层保险：出站 `HTTP(S)_PROXY` 指向一个不存在的端口、`NO_PROXY` 只放
本机。实现见 `src/agent/defaults.js`。

另一个相关的观察：进程环境里没有 `ANTHROPIC_AUTH_TOKEN` 时 CLI 直接报 `Not logged in`，**即使**
`settings.json` 的 `env` 里有它。所以截请求时凭据要留在进程环境里（请求只到本机，不会外泄）。

## 9. 会话叫什么、归哪组：以两个 App 自己的账本为准

2026-10-01 实测（Claude 桌面 App 2.16120.0 / claude 2.1.281 / Codex App 26.928.2636.0）。起因是 owner：
「很多会话名字还是只能靠猜……会话应该要以 app 显示为主」，以及 worktree 会话需与原仓库归同一组（不能用随机 worktree 目录名分组）。下面每条均为协议与盘上账本结构的实测整理：
实现见 `src/titles.js`、`src/repo.js`。

### 9.1 Claude 桌面 App：一行 ≠ 一个 transcript

| 盘上 | 含义 | 当时的量 |
|---|---|---|
| 注册项 `cliSessionId` / `unarchivedCliSessionId` | 这一行**现在**写的 transcript | 165 个注册项 |
| `priorCliSessionIds` / `preClearCliSessionId` | 这一行**以前**写过的 transcript。压缩上下文后 CLI 换新 id 接着写（新文件以 `compact_boundary` 开头），旧 id 记在这里 | 8 个注册项带，旧文件 13 个 |
| 注册项旁的 `deleted_<id>` 文件，内容是毫秒时间戳 | 在 App 里删掉了。删除时为会话自己的 id 和它名下每个 transcript 的 id 各写一个；**transcript 文件留在盘上** | 34 个墓碑，6 个的 transcript 还在 |

App 侧栏的标题取自：`title = n.title || n.spawnedFrom?.title || n.worktreeName`，
**`cwd = n.originCwd || n.cwd`**——worktree 会话的 `cwd` 是 `<仓库>\.claude\worktrees\<随机名>`，
`originCwd` 才是用户选的文件夹，侧栏按它归组。

按文件列会话的后果（改之前）：「Example task (fork)」App 里一行、Baton 七行；「Project init」的压缩前旧段挂在
未归档里（App 里那条已归档）；之前在 App 里删掉的「Demo site」（340 MB）还在列表里。

另：同一个 id 可能在**两个**项目目录下各有一个 transcript（会话中途进了 worktree / 换了目录，带
`relocated`、`worktree-state` 记录）。实测两例都是首条记录相同、一份停写、一份一直写到现在——列还在写的那份。

### 9.2 不在 App 里的会话：CLI 自己的叫法

终端或脚本直接拉起的会话没有注册项。Claude CLI 的 `/resume` 选单通常按如下优先级回退：

```
agentName || customTitle || aiTitle || summary || 首句 || … || sessionId 前 8 位
```

三种名字记录（`agent-name` / `custom-title` / `ai-title`）全量扫 117 个 transcript：前两种之外的
`ai-title` 末条距文件尾最远 30 KB，`agent-name` 31 KB——尾部 64 KB 窗口够用。

### 9.3 Codex App：名字在 `session_index.jsonl`

Codex 桌面端的线程列表取自：`e.name || e.preview || e.id`。`name` 落在 **`~/.codex/session_index.jsonl`**
（每行 `{id, thread_name, updated_at}`，只追加，改名再写一行，后写的为准），与 `state_5.sqlite` 的
`threads.name` 42/42 一致。

v1 设计 §6 以为「Codex 有 24 个可见线程本地没有标题」——**推翻**：都在这个文件里。它当时用的
`thread-descriptions-v1` 是另一样东西（唯一一条是「回复用户的 ok 请求」，App 显示的名字是「回复 ok」），
现在只当老版本兜底。改之前 43 个 Codex 会话只有 5 个和 App 显示的一样。

**一个线程可以有好几个 rollout 文件**：`rollout-<时间>-<线程 id>_<段 id>.jsonl`。第二个 uuid **不是**线程 id
（线程表里查不到），线程表的 `rollout_path` 指向最新那段。App 里一行，改之前 Baton 列六行。

### 9.4 Codex 的「独立聊天」

不归任何项目的线程，App 在 `Documents\Codex\<日期>\<随机短名>` 下给它建工作目录（如短随机目录名），
按 cwd 末段分组就冒出一排随机名的组（实测 20 个）。认法（`.codex-global-state.json`）：

- `projectless-thread-ids`：名单
- `thread-workspace-root-hints`：名单里那些线程的工作区根（例如 `<HOME>\Documents\Codex`）。
  名单偶有遗漏（4 个线程不在名单里、目录却在这个根下），所以目录落在根下的也算

只取**名单里线程**的 hint 当根：项目线程的 hint 是项目根，混进来会把整个项目当成聊天。

### 9.5 将来哪里可能变

- Codex 正在把项目与归属迁进 app-server（全局状态里 `threadAssignmentsMigrated: false`）。迁完后
  `projectless-thread-ids` 可能从 JSON 里消失——那时独立聊天会退回按 cwd 分组，去 `state_5.sqlite`
  （表名带版本号）找替代
- 注册表的字段名（`priorCliSessionIds`、`originCwd`、`deleted_` 前缀）都是 App 内部的，没有文档承诺

## 10. 让模型给新会话起名字

2026-10-08 实测（claude 2.1.281）。owner：「用 claude 原生新建对话不就可以做到和 claude 一样的让他自己
去取标题了吗」。Baton 新建会话走的本来就是原生 CLI（`claude -p --session-id`）——差的不是原不原生，
是桌面 App 在 CLI 之外**另外问了一次模型**。实现见 `src/agent/title.js`。

### 10.1 `-p` 自己不起名

全量扫 117 个 transcript，按 `entrypoint` 分：

| entrypoint | 份数 | 有 `ai-title` | 有 `agent-name` |
|---|---|---|---|
| `claude-desktop-3p` / `claude-desktop` | 109 | 13 | 47 |
| `cli`（交互式） | 1 | 1 | 1 |
| `sdk-cli` / `sdk-ts`（`-p`，Baton 走这条） | 3 | **0** | **0** |

桌面 App 的做法是在一轮结束后调 `query.generateSessionTitle` 写进注册项并同步回 CLI。那条通道是 SDK 的 control request（`--input-format stream-json`），v1 已决定不碰
（见设计文档 §17）。所以 Baton 自己问一次模型。

### 10.2 `--name` 会写进 transcript，但只能在启动时给

`claude -p --session-id <id> --name 探测用名字`，transcript 开头就落了两条：

```
{"type":"custom-title","customTitle":"探测用名字"}
{"type":"agent-name","agentName":"探测用名字"}
```

即 CLI 的 `/resume` 选单里也会显示它。**但名字要等问完模型才有，而那时进程已经起来了**，
所以这条路用不上——除非愿意让新建先干等一次模型调用。

### 10.3 起一次名要 8–14 秒

`claude -p --model <m> --no-session-persistence`，提示词和原文一起走 stdin：

| 模型 | 用时 | 出来的标题 |
|---|---|---|
| haiku-4.5 | 11.1 / 14.4 / 8.7 秒 | 手机消息发送转圈不停 ／ Session cookie dropped on redirect ／ 看表 |
| sonnet-5 | 6.5 秒 | 修手机发消息转圈不停 |

两个都给得出像样的标题（英文原文会保持英文）。**这个时长挡不得**：新建那一屏等的是第一轮。
所以 Baton 并着第一轮一起跑，回来再改注册项的标题（`retitleRegistryEntry`，读回来再改，
不拿内存里那份覆盖 App 的改动；人在 App 里改过名字就不动）。

`--no-session-persistence` 实测不留 transcript（跑完查过 `~/.claude/projects`，没有新文件），
所以这次调用不会在 App 侧栏或 Baton 列表里冒出一条。

### 10.4 Codex 这边不做

Codex 的名字在 `~/.codex/session_index.jsonl`（§9.3），那是 Codex App 自己的索引。往里写就是
「自建会话身份映射」那条禁令的另一种写法，而 Baton 没有别的地方可以存一个 Codex App 也认的名字。
所以 `codex exec` 建的会话仍然显示首句——这是已知差距。

## 11. 哪些会话此刻在跑：CLI 自己有一份进程登记

2026-10-08 实测（claude 2.1.281 / 2.1.286）。owner：「我刚刚下班，打开手机，就看不到哪些会话是还在
工作的」——Baton 原来只认自己起的那一轮，桌面 App 和终端里起的轮次在手机上看着和闲着一样。
实现见 `src/runtime/live.js`。

### 11.1 `~/.claude/sessions/<pid>.json`

每个活着的 CLI 进程一个文件。实测内容（去掉无关字段）：

```json
{"pid":12836,"sessionId":"1a825259-…","hostSessionId":"local_fcbfb020-…","cwd":"C:\\workspace\\demo",
 "status":"waiting","waitingFor":"input needed","statusUpdatedAt":1791455481577,
 "entrypoint":"claude-desktop-3p","kind":"interactive","name":"Dashboard optimization"}
```

| 字段 | 用处 |
|---|---|
| `sessionId` | **当前这段** transcript 的 id（压缩之后会换，见 §9.1） |
| `hostSessionId` | `local_<cliSessionId>`，就是桌面 App 注册项那个 id |
| `status` | `busy` / `idle` / `waiting` |
| `waitingFor` | 等什么，实测见过 `input needed` |

CLI 内部对 `waiting` / `busy` / `idle` 的判定逻辑如下（`waitingFor` 优先于 loading 状态）：

```js
k = waitingFor(h);                                  // queuedElicitation 之类
if (k !== undefined) return { status: "waiting", waitingFor: k, working: false };
return { status: h.isLoading || h.delegatedActive ? "busy" : "idle", working: h.isQueryActive };
```

所以 `waiting` 是「在等人」，不是「在跑」——两者要分开显示。

### 11.2 这份登记可不可靠

| 问的事 | 实测 |
|---|---|
| 进程起来会不会写 | 会。起一个真的 `claude -p`，4 秒后目录里多出一个 `status: busy` 的文件 |
| 进程退了会不会删 | 会。那次探测的进程一退，文件就不见了 |
| busy 是不是真在跑 | 是。当时报 busy 的三条会话，transcript 的写入时间都在几十秒内 |
| 一个会话几个文件 | 会有。宿主那个 CLI 报 idle、真正干活的子进程（`entrypoint: sdk-cli`）报 busy，两个文件的 `sessionId` 相同——**取 busy 那个**，照「最后读到的」写会把它盖掉 |
| 崩溃退出 | 文件会留在盘上，所以**必须查 pid 还在不在**（`process.kill(pid, 0)`；EPERM 也算活着） |

残余风险：pid 被系统复用、而那个旧文件又没删掉时会误判一次。代价是一颗点亮错，没做更重的防护
（文件里的 `procStart` 可以比对，但要走 WMI）。

### 11.3 Codex 这边没有对等的东西

- `~/.codex/thread-writer-locks/<threadId>.lock`：实测那把锁是**三小时前**的，对应线程早就停了——
  它是「最后写的人」不是「正在写」
- `codex app-server` 是一个进程管所有线程，进程表里认不出是哪条线程在跑
- `state_5.sqlite` 的 threads 表没有运行态字段

只剩「rollout 文件刚被写过」这种近似。owner 2026-10-08 拍板：**先只做 Claude**，Codex 维持原样
（只认 Baton 自己起的轮次）。

### 11.4 `waiting` 不能拿来挡发送

§11.1 那段 CLI 代码里 `waiting` 有五种来源：

```js
if (h.queuedElicitation) return "input needed";
if (h.topDialogWaitingFor !== void 0) return h.topDialogWaitingFor;
if (h.pendingWorkerRequest) return "worker request";
if (h.pendingSandboxRequest) return "sandbox request";
if (h.isShowingLocalJSXCommand && !h.isResponseStreaming && !h.delegatedActive) return "dialog open";
```

**最后一种只是「某个本地命令的界面开着、什么都没在跑」**——离「这个会话正忙」很远。

2026-10-09 一度把 waiting 也当成「不许发」（怕第二个 `--resume` 撞上），owner 当场否掉：
「那我不是离开电脑就永远发不了消息了吗」。那个框要人**在电脑前**点才会消失，而 Baton 存在的
理由就是人不在电脑前。所以：

- `busy` → 排队。那一轮自己会跑完，几分钟内就发出去了
- `waiting` → 照发。只在列表上用一颗琥珀色的点如实告诉人「这条在电脑上等你」

**把那个框搬进 Baton 让人在手机上点，做不到**：这份进程登记里只有 `waitingFor` 一个短字符串
（`"input needed"` 这种），没有问题正文、没有选项、也没有回答的通道——框是走 App 与 CLI 之间
那条控制通道的（SDK 的 `--input-format stream-json`，v1 决定不碰）。Baton 自己那套提问卡片
（`src/ask/`）只对**它自己起的**轮次有效：那是它往那一轮里塞了一个 MCP 服务器。

### 11.5 两个 `--resume` 撞在一起会怎样：分两种

2026-10-09 实测。**开着与没开着，结论相反**，所以 Baton 的排队规则只能按这个分。

**会话在桌面 App 里开着**：安全。进程登记里那条有 `messagingSocketPath`（一条命名管道），
`-p --resume` 会把消息交给那个活着的会话，由它自己排队——transcript 仍是一条直线。
实测样本就是 owner 当天那条消息：

```
19:07:30  手机发出 → Baton 排队
19:10:01  Baton 起 claude -p --resume <id>
19:10:04  transcript 里两条 queue-operation（CLI 自己在排）
19:10:19  user 记录落下，promptSource=sdk，parentUuid 接在上一条之后
```
另一个佐证：一个长期用 Baton 的会话里 27 条人发的消息有 17 条是 `promptSource=sdk`，
全在同一个 transcript、同一个 sessionId 下。

**会话没开在任何地方**（终端 `-p`，进程登记里**没有**管道）：会把对话树劈叉。
造了一条会话，A 起一轮慢的，7 秒后 B 再 resume 同一条，两边都写进同一个文件，但是：

```
user      uuid=03b1b76c parent=c3e9c3ee   把 1 到 600 …        ← A 的消息
assistant uuid=a1b3a607 parent=03b1b76c   No response requested.   ← B 启动时给 A 的消息补了个空壳
user      uuid=df6e6044 parent=a1b3a607   只回两个字：插队        ← B 接在那个空壳后面
assistant uuid=77ffd851 parent=03b1b76c   1 2 3 4 5 …          ← A 的真答案，挂在另一支上
```

`03b1b76c` 有了两个孩子——A 那一支被甩在旁边，后续 resume 只会沿着 B 那一支走。

所以：`busy` 时默认排队；人按「立刻发送」（`when: 'now'`）就照办——在 App 里开着的会话这么做
本来就安全，没开着的则是他自己选的代价。**Baton 自己那一轮不受 `when` 影响**：那一轮有句柄，
要插队的正确做法是先停掉它。

> 第一次做这个实验时写错了：PowerShell 函数的参数起名叫 `$args`——那是自动变量，
> splatting 用的是自动那份，`--session-id` / `--resume` 根本没传进去，于是每轮都新开一条会话，
> 差点据此得出「`-p --resume` 会 fork」的错误结论。

## 12. 账号登录与中转并存时，环境变量说了算

2026-11-03 实测，`claude` 系统安装版。起因：VS Code 里已经换成账号登录，Baton 起的轮次却还在走中转。

**做法**：本机起一个假端点，把 `ANTHROPIC_BASE_URL` 指过去，`claude -p` 的第一条请求打到这里就回 400 收掉
（请求不出本机）。只看请求带的是哪种凭据，不记值。`~/.claude/.credentials.json` 里有有效的账号登录：

| 进程环境 | 请求里的凭据 | `anthropic-beta` 含 `oauth` |
|---|---|---|
| 没有 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` | 账号的 OAuth token（`sk-ant-oat…`） | 是 |
| 另设了 `ANTHROPIC_AUTH_TOKEN` | 环境变量里那个 | 否 |

**环境变量优先，账号登录被整个盖掉。** `stream-json` 的 init 记录里那个 `apiKeySource` 在两种情况下
都是 `none`——它不报 `ANTHROPIC_AUTH_TOKEN`，**拿它判断走的哪路是错的**。

**对 Baton 的含义**：

1. 每一轮的 `claude` 继承守护进程的环境，而守护进程的环境是**启动那一刻**由 `scripts/start-daemon.ps1`
   从注册表读的快照。外部工具事后删掉用户级 `ANTHROPIC_*`，跑着的守护进程看不见——要连外层那个
   pwsh 一起重启（只杀 node 不够：外层循环用的还是它自己那份旧环境）
2. 账号登录时环境变量里本来就没有 token。§6 那条「缺 `ANTHROPIC_AUTH_TOKEN` 就拒绝发送」因此改为
   「环境变量和 `~/.claude/.credentials.json` 都没有才拒绝」（`src/agent/preflight.js`）

## 13. 套餐额度从哪来

2026-11-06 实测，`claude` 2.1.312、Codex rollout（11-04）。服务端实现在 `src/usage.js`，接口 `GET /api/usage`（owner 专属）。

**Claude**：没有落盘的地方——transcript 只在**撞上限之后**记一条 `apiError: "usage_limit_reached"`
（带 `rate_limit_info.rateLimitType: "five_hour"` 与 `resetsAt`），平时用了多少不记。
Claude Code 自己的 `/usage` 问的是 `GET https://api.anthropic.com/api/oauth/usage`（包含
`five_hour` / `seven_day` / `seven_day_opus` / `seven_day_sonnet` 等限额窗口）：

- 带账号登录的令牌：`~/.claude/.credentials.json` 的 `claudeAiOauth.accessToken`，头 `anthropic-beta: oauth-2025-04-20`
- **直连回 403 `Request not allowed`**——这台电脑出口在国内；claude 自己走 `~/.claude/settings.json` 的
  `env.HTTPS_PROXY`。走同一个代理就是 200。Node 的 fetch 不认代理环境变量，`src/usage.js` 手写了 CONNECT 隧道
- 返回里 `limits` 数组最好用：`{ kind: "session" | "weekly_all" | …, percent, resets_at }`；
  `five_hour.utilization`、`seven_day.utilization` 是同样的数。其余几十个键当时全是 null
- 令牌过期**不替它刷新**：refresh token 可能是一次性的，抢着刷会把 claude 自己的登录弄掉
- 走中转（设了 `ANTHROPIC_BASE_URL`）时这个接口没意义，直接说看不到

**Codex**：没有可问的端点，但 rollout 里每轮都有 `event_msg` / `payload.type: "token_count"`，带
`payload.rate_limits`：`primary` / `secondary` 各一个窗口（`used_percent`、`window_minutes`、`resets_at` 秒），
外加 `plan_type`。`window_minutes: 10080` 是一周、300 是 5 小时。取最近一份 rollout 的最后一条——
它是**上次跑 Codex 时**的数，界面上要连同时间一起报。

**2026-11-07 更正（Codex）**：上面「Codex 没有可问的端点」是错的，读 rollout 的数也不准——owner 当天就发现
「这周还剩 60%」而界面说已用 19%：那条是 11-04 本机最后一次跑 Codex 时记的，之后在别处用掉的不会出现在这台
电脑的 rollout 里。codex 0.164.0 的 `codex app-server`（stdio JSON-RPC）有 `account/rateLimits/read`：

```
→ {"id":1,"method":"initialize","params":{"clientInfo":{"name":"baton","version":"0.1.0"}}}
→ {"method":"initialized"}
→ {"id":2,"method":"account/rateLimits/read"}
← {"id":2,"result":{"rateLimits":{"primary":{"usedPercent":40,"windowDurationMins":10080,"resetsAt":1794290073},
     "secondary":null,"planType":"pro",…},"rateLimitsByLimitId":{"codex":{…}},…}}
```

已用 40%，正好对上 owner 看到的剩 60%。字段是驼峰（`usedPercent` / `windowDurationMins` / `resetsAt`），
rollout 里是下划线。一次约 2.4 秒；Windows 上 codex 是 .cmd、经 shell 起，收的时候要 `taskkill /t`，
不然只杀到那层 cmd.exe。rollout 只在现问失败时兜底，界面上标「上一轮记下的」。

界面显示的是**剩余**（100 − 已用），owner 定的。

## 14. Codex 的会话写入锁：App 开着那个会话，`codex exec resume` 就进不去

2026-11-08 实测，codex 0.164.0（App 内置那份同代）。owner：「我给 codex 发消息根本发不出去，baton 界面也没显示」。

- codex 新加了 `~/.codex/thread-writer-locks/<thread_id>.lock`，同一个会话同一时间只许一个进程写。
  当时 Codex Desktop App 开着这个会话，锁在它手里——
  用 `FileStream.Lock(0,1)` 非阻塞试锁，回「另一个程序已锁定文件的一部分」
- Baton 起的 `codex exec resume <thread> --json` 拿不到锁，**7 秒就退出，stdout 一条 JSON 都没有**，
  原因只在 stderr（`failed to acquire thread writer lock …`）。消息根本没进 rollout，
  而 Baton 的会话页从 rollout 读内容——于是那条消息凭空消失
- 原来 `summarizeTurn` 只读 stdout，失败原因永远是「没有任何终态记录」；网页端收到 `turn_end` 也只停秒表，
  不显示错误。现在：stdout 里找不到终态和 error 记录时取 stderr 末几行（去掉 `Reading prompt from stdin...`
  与 Node 弃用警告），命中写入锁就换成一句能照做的话；网页端失败时在输入区挂一条提示，这个页面发的那条
  能「放回输入框」
- **怎么绕开**：在 App 里切到别的会话或关掉 App 再从 Baton 发；或者就在 App 里接着聊。App 切走以后锁会不会立刻
  放，没验证（要 owner 在 App 里操作一下才看得到）
- 复现不碰真会话的办法：给临时 Baton 实例的 PATH 最前面放一个假的 `codex.cmd`，往 stderr 写那句锁错误后 `exit /b 1`

## 15. 会话被 Codex App 占着时：把消息交给 App 排队

2026-11-09，codex 0.164.0。§14 只把失败说清楚了；owner：「baton 的意义就是立马能接手，而不是还要我去手动
关闭——我人都不在电脑面前怎么手动关闭？」

**App 一直占着锁，不只是跑一轮的时候。** 锁文件 19:22 建、之后 App 在这个会话里跑了好几轮它都没换过；
App 会把打开过的会话一直加载着，离开很久之后才 teardown（`logs_2.sqlite` 里
`clearing thread listener during thread-state teardown … had_active_turn=false`）。所以「等 App 这一轮跑完」没用。

**连不上 App 的 app-server。** 它是桌面端用 stdio 起的（命令行里没有 `--listen`），没开控制 socket：
`codex app-server proxy` 要的 `app-server-control/app-server-control.sock` 不存在，日志里也没有
`control socket listening`。控制 socket 只在 `codex app-server daemon` 那种模式下有。

**但队列是跨进程的。** `~/.codex/queue_1.sqlite`（`queued_items` + 按会话递增的 `queued_thread_revisions`）。
自己起一个 `codex app-server`，`initialize` 带 `capabilities.experimentalApi: true`，然后：

```
→ {"id":2,"method":"thread/queue/add","params":{"threadId":"…","clientUserMessageId":"<uuid>",
     "input":[{"type":"text","text":"…","text_elements":[]}]}}
← {"id":2,"result":{"queuedSubmission":{"id":"01a1bbe5-…","input":[…],"clientUserMessageId":"…"}}}
```

**8 秒后** App 的 app-server 发出 `thread/queue/changed`，App 界面随即 `thread/queue/list`——它看见了这条。
（00:02:37 加入，00:02:45 两条 changed + list，同一个 process_uuid 一直跑到现在，是 App 的那个。）
参数形状来自 `codex app-server generate-json-schema --experimental`（`ThreadQueueAddParams` 等；不带
`--experimental` 导出来的只有 `ThreadQueueChangedNotification`）。

Baton 的做法（`src/agent/codexQueue.js`、`handlers/turns.js` 的 `defaultRunner`）：照常 `codex exec resume`；
`summarizeTurn` 判出是写入锁（`lockHeld`）就改为 `thread/queue/add`，这一轮记成新终态 **`handoff`**
（不是失败），手机横幅 / 网页提示条说「已交给 Codex App」。回复由 App 写进同一个 rollout，Baton 本来就在读。

早期的手记里提到过「`codex queue` 只入队不执行」——那是 0.157 时代没人占着会话的情形，那时队列确实没人消费。
现在消费它的是占着锁的 App。

**闭环实测（同一晚）**：测试消息 00:02:37 入队时 App 正在跑一轮长活；**00:32:00 那一轮 `task_complete` 的同一秒**，
App 就开了新的一轮，`task_started.turn_attribution.turn_trigger` 是 **`"queue"`**；00:34:30 测试消息作为
`role: user` 写进 rollout，00:34:32 回「收到」，`task_complete`。全程没人碰电脑。
所以「交给 App」的延迟 = App 手上那一轮还剩多久；App 空闲时应当立刻开跑（这一点没单独测）。

**2026-11-09 更正：exec 撞锁时打的是另一句。** 上面写的 `failed to acquire thread writer lock` 是锁文件层面的报错，最初误当成了 `codex exec resume` 会打的那句，测试里的假 codex 也照着推测写——测试全绿，
线上一次都没命中，导致两条消息未能入队。拿真的 `codex exec resume` 撞 App 占着的锁（只在确认锁被占着时才撞，
撞上了它在写任何东西之前就退出），stderr 原文是：

```
ERROR codex_core::session::session: failed to initialize thread persistence: thread-store conflict:
  thread 01a1a01d-… already has an active writer
Error: thread/resume: thread/resume failed: thread 01a1a01d-… already has an active writer (code -32600)
```

`adapt.js` 现在两句都认，测试用的是这段原文。**教训：判据要用真实输出写，不能用推测的输出写测试再让它变绿。**

**App 空闲时：4 秒。** 同日 09:33 用修好的代码、真 codex、真会话走完整条路：`exec resume` 3.3 秒判出锁冲突 →
`thread/queue/add` → App 那时没在跑，**4 秒后**以 `turn_trigger: "queue"` 开跑，用户消息写进 rollout。

## 16. Claude Code 的模型目录：`/model` 照它列

2026-11-10，claude 2.1.322（官方账号登录）。owner：「我用 claude code 用 /model 的时候列出来的比我们的多得多，
并且当前的模型选择还存在重复的情况——明明已经有 opus 和 sonnet 了又有重复的」。

当时 Baton 给 Claude 的是 5 项：transcript 里跑过的 Opus 5.5 / Sonnet 5.5，加上 `claude --help` 里写的别名
`opus` / `sonnet` / `fable`。`agent/catalog.js` 抬头还写着「`~/.claude` 下没有任何模型缓存」——那是旧版查的，
没有重查就沿用了。

**现在有目录了。** Claude Code 从 `https://downloads.claude.ai/model-catalog/v1/catalog.json` 拉一份带签名
（RSASSA-PKCS1-v1_5 / SHA-512）、按账号下发的目录，拉不到就用程序里内置的那份，缓存在：

```
~/.claude/cache/model-catalog/<组织 id>-<hash>-cc.json     组织 id = ~/.claude.json 的 oauthAccount.organizationUuid
{ version, fetchedAt, staleAt, catalog: { surface: "cc", state: {…}, config: {
    models: [ { id, name, short_name, description, section: "main"|"overflow"|"deprecated", disabled?,
                notice?, badge?, tooltip?, thinking: { type: "effort"|"none" },
                runtime: { max_input_tokens, effort_levels, default_effort, family }, offered_on: [...] } ],
    provider_alias_targets: { opus: { default: "claude-opus-5-5", per_provider: { gateway: "claude-opus-4-7", … } }, … }
} } }
```

当天这份是 13 个：`main` 4 个（Opus 5.5 / Sonnet 5.5 / Fable 5.2 / Haiku 5.5），`overflow` 9 个
（Fable 5.1、Haiku 4.5、Sonnet 5、Opus 5、Fable 5、Opus 4.8 / 4.7 / 4.6、Sonnet 4.6）。程序里的过滤是
`disabled !== true && section !== "deprecated"`，再按 `offered_on` 挑当前路线（直连是 `first_party`）。
强度逐模型不同：Opus 4.6 / Sonnet 4.6 没有 xhigh，Haiku 4.5 `thinking.type: "none"`（不能调），
默认档也不同（Opus 5.5 medium、Opus 4.7 xhigh、Fable 5.1 high……）。

**别名就是重复。** `provider_alias_targets` 里 `opus → claude-opus-5-5`、`sonnet → claude-sonnet-5-5`、
`fable → claude-fable-5-2`。`/model` 不列别名，只列具体型号。

**owner 存过的强度另有一处。** `/model` 里调过的强度落在 `~/.claude/settings.json`：
`modelSettings: { "claude-opus-5-5": { "effortLevel": "xhigh" } }`。CLI 起一轮、没带 `--effort` 时，
按设置来源逐层找：**该模型的 `modelSettings` 项 > 顶层 `effortLevel` > 目录 `default_effort`**；
键先归一（去 `[1m]`、别名换成型号），同一型号有精确键用精确键。同日用 `agent/defaults.js` 的探测问出来的默认是「Opus 5.5 · xhigh」、
而目录写 medium，原因就在这里。

Baton 的做法（`agent/catalog.js` 的 `claudeCatalog`、`models.js` 的 `claudeList` / `claudeEffortPins`）：
直连且目录在时，整张表照目录列、次序照目录，`overflow` 收进「更多」（跑过的不收），每项带 `listed: true`
（强度表是权威的，空表 = 不能调），默认强度叠上 `modelSettings`；别名不列。走中转或没有目录时退回原来的
「跑过的 + 配置里的 + 别名」，但别名指向的型号已在表里的不放。说明是英文的，认得的几句换成中文，
认不得的原样给。

## 17. `codex doctor`（0.164）：要跑 100 秒，沙箱那段换了格式

2026-11-10，codex-cli 0.164.0。Baton 用 `codex doctor` 判断 Codex 沙箱有没有预置好（`agent/sandbox.js`，
没预置好时 `--sandbox workspace-write` 会挂住 150 秒，所以要在放出选项前知道）。两处变了：

**慢。** 同一台电脑上 `codex doctor` 跑完要 **1 分 40 秒**（有一项是连 websocket、15 秒超时；还有 git、
Defender、rollouts 体积等一长串检查）。原先 Baton 同步等它、上限 20 秒：次次超时，答案永远是 `unknown`，
而且每次缓存过期后第一个打开会话配置的人要干等 20 秒（线上 3002 实测 `/api/permission` 20 秒不回，
界面上「权限档位」一直是「正在读…」）。

**格式。** 0.157 前后是一行：

```
⚠ sandbox      elevated Windows sandbox provisioning is incomplete or outdated
```

0.164 是一段，backend 那行排在 provisioning 前面：

```
✓ sandbox      unrestricted fs + enabled network · approval Never
    …
    sandbox backend          elevated
    …
    sandbox provisioning     complete
```

原判据「同一行有 sandbox 又有 provisioning|elevated」抓到的是 backend 那行，它永远不含 incomplete——
沙箱没装好也会答 ready。现在先找 `sandbox provisioning` 那行，只认它。

Baton 的做法：doctor 改在后台跑（守护进程启动时预热一次，单飞，上限 3 分钟，结果缓存 30 分钟）；
接口有旧答案先回旧的，头一回最多等 1.5 秒，已经有一次在跑就直接回 `unknown`。

## 18. 斜杠命令、`/goal`、Claude Desktop 右侧窗格的数据

2026-11-10，claude 2.1.322。owner：「相比 claude desktop 还是少了很多内容，比如目标模式，以及输入 / 的命令，
还有右侧的信息窗口」。

**`claude -p` 认斜杠命令，消息要走 stdin。** 用 Haiku 在临时目录实测：stdin 送 `/goal 条件`，CLI 先回
`Goal set: 条件`，然后 agent 一直干到条件满足才停（建了文件、自己核对过才收尾）。第一次测试从 Git Bash 把
`/goal …` 当**参数**传，被 MSYS 当成路径改写成 `C:/Program Files/Git/goal …`，模型收到的是一句普通话——
Baton 本来就走 stdin，没有这个问题；**在 Git Bash 里手测斜杠命令一律用管道**。

`/goal` 在 Claude CLI 内部实现为 `goalNonInteractive`（`supportsNonInteractive: true`，参数 `[<condition> | clear]`），
靠一个会话级 Stop hook 在 agent 想停时检查条件；要求受信任的工作区、hooks 没被策略禁掉。

**能用哪些命令：`system/init`。** `--output-format stream-json` 一启动、发请求之前就吐：

```
slash_commands            这个目录下非交互能用的命令（当天 109 个：内置 36 + 技能 + 插件命令；项目级的也在）
skills                    其中哪些是技能
terminal_slash_commands   只能在终端界面里用的（doctor / color / focus / reload-plugins）
plugins                   插件名 → 盘上目录（技能说明去 <目录>/skills/<名>/SKILL.md 读）
```

Baton：每一轮真跑时顺手记下，记录里没有就用 §8 那种假端点探针只取 init（约 4 秒，不花钱）
（`src/agent/commands.js`）。

**transcript 里怎么记（一个 `/goal` 的一生）：**

```
user    <command-name>/goal</command-name><command-message>goal</command-message><command-args>条件</command-args>
system  subtype=local_command  content=<local-command-stdout>Goal set: 条件</local-command-stdout>
user    isMeta  "A session-scoped Stop hook is now active with condition: …"
attachment  { type: goal_status, met: false, sentinel: true, condition }     刚设上
attachment  { type: goal_status, met: false, condition, reason }              想停、检查没过，被打回去
attachment  { type: goal_status, met: true,  condition, reason }              达成
system  subtype=stop_hook_summary
```

命令回执还有老写法：一条 user 记录，正文就是 `<local-command-stdout>…`（本机 61 条，新写法 32 条）。

**命令块不全是人打的。** 本机全量数过：`/model` 48（桌面 App / VS Code 的模型选择器写的）、`/reload-skills` 12
（桌面 App 自己写的）、`/goal` 12、`/loop` 9、`/compact` 6（都紧跟在压缩摘要后面）……只有 **`entrypoint: sdk-cli`**
（经 `-p` 发的，Baton 就是）能当成人发的消息。Baton 的处置（`src/claude.js`）：sdk-cli 的命令是用户气泡
「/goal 条件」；别处记下的是一行小字（`command_output`）；`reload-skills` 连同回执不显示。

**Claude Desktop 右侧窗格的数据来自它注入给 agent 的工具**（本机最近 40 个 Claude 会话）：

```
mcp__ccd_turn__update_plan   136 次  { items: [{content, status}], scope }，之后 { advance: true } 推进一格
mcp__ccd_turn__wrap_up        40 次  { recap: "一段收尾总结" }
mcp__ccd_pr__get_status       39 次  {}（PR 状态）
mcp__Claude_Browser__preview_*      预览窗格
TodoWrite                      0 次  这台机器上已经没人用了
```

这些工具只在桌面 App 里开的会话才有；Baton 用 `-p` 跑的轮次里没有。Codex 0.164 改文件走 `exec`
（2968 次，没有单独的改文件记录），上下文用量在 `event_msg/token_count` 的 `last_token_usage.input_tokens`
与 `model_context_window`，模型在 `turn_context.payload.model`。Baton 的读法见 `src/sessioninfo.js`。

## 19. 句中的 `/`：Claude 与 Codex 各认什么

2026-11-11，claude 2.1.322 / codex-cli 0.164.0。owner：「codex 的适配去哪了？/ 命令呢？而且你的 / 命令只能在
刚开头用，我用 claude desktop 或者 codex 的时候随时输入 / 都支持，只要 / 前面带个空格区分」。

**Claude**：CLI 会逐个扫描消息中的 `/名字` —— 开头那个当命令跑；句中的、前面是空白的、名字是
`prompt` 类（技能、自定义命令）的，生成一个 `skill_mention` 附件。但**经 `-p` 发的消息不走这段**：stdin 送
「请看 /my-skill 这个技能……」，transcript 里只有平常的 `skill_listing`，没有 `skill_mention`。所以经 Baton
发出去时，句中的 `/技能` 是写给模型看的一次点名（它读得到、通常会去用），不是 CLI 强制加载；内置命令（/compact
这类）写在句中什么也不会发生。界面因此在句中只列技能和插件命令。

**Codex**：点名技能的写法是 **`$名字`**（Codex 支持以 `$skill-name` 显式调用，经 `collect_explicit_skill_mentions` 注入）。实测 `codex exec`：

```
stdin「请看 $my-skill 这个技能……」  → 这一轮多一条 user 消息 <skill><name>my-skill</name><path>…SKILL.md</path>整份内容</skill>
stdin「请看 $pdf:pdf 这个技能……」  → 同上（插件技能带冒号照样认）
stdin「请看 /my-skill 这个技能……」  → 没有注入，模型只能凭技能清单里那一句描述回答
```

技能表从 app-server 的 `skills/list`（`{ cwds: [目录] }` → `data[0].skills[]`：name / description / enabled /
interface.shortDescription / path）拿，本机这个目录 61 条、同名去重后 54 条，起 app-server 问一次约 1.2 秒。
Codex 的 `/compact`、`/review` 这些内置命令只在它自己的界面里（app-server 有 `thread/compact/start`、
`review/start`，exec 不认），Baton 的表里只放技能。

所以界面：光标所在那个词以 `/` 开头（Codex 另认 `$`）、前面是行首或空白就弹；选中后插入 agent 真认的写法——
Claude `/名字`，Codex `$名字`（`web/src/slash.ts` / `app/src/api/slash.ts`，`src/agent/commands.js`）。

**实测的副作用和收尾**：`codex exec` 每跑一次都会在 `~/.codex/state_5.sqlite` 的 threads 表里登记一条
（Codex App 的列表读它），删 rollout 文件不够；用 app-server 的 `thread/delete`（`{ threadId }`）删，不要直接改
Codex App 正开着的数据库。只看回答不看记录时用 `codex exec --ephemeral`。

## 20. Codex 的目标

2026-11-11，codex-cli 0.164.0。owner：「codex 那里还是看不到目标啊」。

**存在哪**：`~/.codex/goals_1.sqlite` 的 `thread_goals`（一个会话一行：objective / status / token_budget /
tokens_used / time_used_seconds / created_at_ms / updated_at_ms）。status 在库里是蛇形：active / paused / blocked /
usage_limited / budget_limited / complete；app-server 消息里是驼峰（usageLimited…）。本机 15 条，owner 用得很多。

**怎么读写**：app-server 的 `thread/goal/set`（`{ threadId, objective, status, origin: 'user' }`）/ `get` / `clear`，
通知 `thread/goal/updated` / `cleared`。实测从一个**另起的** app-server 设目标，不用先把会话载入就能设上（写进库）。
Baton 读直接只读那张表，写走官方方法，不碰它的库。

**会话记录里留什么**：
- 人设 / 暂停 / 恢复：一条 user 角色的内部上下文 `<codex_internal_context source="user_goal">`，
  `User set the goal: "…"` + `User set goal status: "active".`，或者只有后一句（只改状态）。App 改的时候还另写一条
  `event_msg/thread_goal_updated`，exec 那边不写
- 续跑的那一轮：`task_started.turn_attribution.turn_trigger = "goal"`，开头一条 `source="goal"` 的「Continue working
  toward the active thread goal…」上下文
- 模型标完成：`thread_goal_updated` 带 status complete（App）；exec 里只改库

**谁来「接着干」**：只有开着这个会话的进程（二进制里 "skipping goal continuation because thread manager is
unavailable / live thread is unavailable"）。App 开着就是 App（那个会话里 30 轮 turn_trigger: goal）。实测：从外面设了目标，
90 秒里没人开工；再 `codex exec resume` 一次，这一轮就是目标续跑（带上目标上下文），干完模型自己把状态标成 complete
（9618 token、14 秒）——但 exec 跑完一轮就退出，不会自己再起下一轮。

Baton 的做法：信息窗格读那张表；对话里人的操作取 user_goal 上下文、Codex 自己改的状态（complete / blocked / 额度预算）
取 thread_goal_updated，不重复（`src/codex.js`）；设 / 清走 `handlers/goal.js`（设完立刻发一轮开工）；每轮 ok 地结束、
没人排队、库里还是 active，就再起一轮续跑（`handlers/turns.js` 的 continueGoal，连续 30 轮为止），续跑那一轮撞上 App 的锁
就交给 App 自己续。续跑那句以标签开头（`<baton_goal_continue>`），被解析当前言滤掉，不冒成气泡。

实测用的探测会话已经用 `thread/delete` 删掉（库里两张表都查过是 0 行）。

## 21. 插队：停下这一轮，马上发

2026-11-14。owner：「我刚刚和 claude 对话，还是不能自己选择插队还是排队啊」。

两家都有「往正在跑的这一轮里塞一句、不打断」：Codex app-server 有 `turn/steer`；Claude 的 `queued_command` 附件和
SDK 那句「Queued sends may coalesce into fewer turns」说明 stream-json 输入下跑着时再写进 stdin 的话会在工具调用的间隙
递进去。但 Baton 一轮一进程：Claude 的消息写进 stdin 就关了，Codex 用的是 exec 进程——两边都没有中途递话的入口，
要做得改掉每一轮的启动方式，另行实测。

现在的「插队」是：这条放到队列最前（`queue.enqueue({ front: true })`），把 Baton 自己那一轮停下（stopTurn，终态写
「插队：停下这一轮，先发新的那条。」），停下后的收尾（settle → drainQueue）第一个取它。和在 Claude Code 里按 Esc 再打字
同一个效果：做过的都在。在等电脑上那一轮时就是原来的 `when: 'now'`。界面：网页端跑着的时候框里有字就多一颗「插队」
（Ctrl/⌘+Enter），回车照旧排队；排着的消息一条一行，带「插队 / 撤回」；手机端排着的那几条一直给「插队」。

## 22. 一次工具调用成没成：两边都记着，只是要知道看哪儿

2026-10-10 全量实测（claude 2.1.281 / codex-cli 0.157.0；126 个 Claude transcript、153 个 Codex rollout）。
起因：手机端在工具输出末尾找 `error|failed|fatal|Traceback|not found` 来标红，owner 看到的「有失败」
大半不对。实现见 `src/claude.js`、`src/codex.js`：有失败标记时工具结果带 `tool.failed: true`，
**没有就不带这个字段**——「没说失败」不等于「说了成功」。客户端只认它，不再猜词。

### 22.1 Claude：`tool_result.is_error`

| | 条数 |
|---|---|
| 工具结果 | 70745 |
| `is_error: true` | 1685 |
| `is_error: false` | 39018 |
| 没有这个字段 | 30042（当成没出错） |

拿它对照猜词法（输出末尾 600 字）：

| | 条数 |
|---|---|
| 猜对的失败 | 778 |
| 冤枉的（没出错却标红） | **4980**——`errors: none`、`0 failed`、网址里的 `/error`、TypeScript 的 `error TS6133` 警告 |
| 漏掉的（出错了没标） | **907**——`File does not exist.`、`EPERM`、被拒绝的工具调用，一个关键词都不带 |

`is_error` 的输出开头最常见的是 `Exit code N`、`<tool_use_error>`、`The user doesn't want to proceed
with this tool use`（人在电脑上点了拒绝，也算这一步没成）。

### 22.2 Codex：写在结果的第一行

| 工具 | 结果开头 | 实测 |
|---|---|---|
| `shell_command`、`apply_patch` | `Exit code: N` | 0 的 5676 条、正数 800、**负数 11**（Windows 的异常码，如 `-2147450749`） |
| `exec`（code mode） | `Script completed` / `running` / `failed` / `terminated` | 11472 / 1024 / 400 / 5 |
| 其余（`wait_agent`、`spawn_agent`……） | JSON 或普通文本 | 不报成败 |

- `Exit code` 不是 0 就是失败，负数也是
- `Script running with cell ID N` 是格子还没跑完，结果要靠后面的 `wait` 取；**不算失败**
- `Script terminated` 是被中途杀掉，算失败
- **只看第一行**：正文里的 `error`、`fatal` 是命令打印出来的东西，不是它的成败（`Script completed`
  下面照样可能有一行 `fatal: not a git repository`）

rollout 里另有 `event_msg` 的 `item_completed`，`CommandExecution` 带着 `exit_code` 和 `status`
（4569 条：completed 4084、failed 485）。**没有逐条和上面的第一行对过**。Baton 不读它：第一行
已经够，而 `item_completed` 和工具调用之间还要另配一次 id。

### 22.3 用服务端自己的解析器复核

把全部 transcript / rollout 过一遍 `claudeEvents` / `codexEvents`：Claude 标出 1687 条
（比 22.1 多的 2 条是这期间新跑的）；Codex 标出 1216 条，正好等于 800 + 11 + 400 + 5。

## 23. Gemini Antigravity 适配实测

2026-11-17 本机（Windows 11）实测与适配记录，对应源码：`src/antigravity.js`、`src/agent/antigravityBridge.js`、`src/agent/antigravityRun.js`、`sidecars/baton-bridge/`。

### 23.1 会话与索引路径

- 会话转录目录：`~/.gemini/{antigravity,antigravity-cli,antigravity-ide}/brain/<conversationId>/.system_generated/logs/`。
- 同目录下若同时存在 `transcript_full.jsonl` 与 `transcript.jsonl`，`antigravitySessionFiles` 优先读取 `transcript_full.jsonl`（包含未截断内容与完整工具载荷）。
- SQLite 摘要库：`~/.gemini/{antigravity,antigravity-cli,antigravity-ide}/conversation_summaries.db`（只读表 `conversation_summaries`，使用 Node 24 内置 `node:sqlite` 的 `DatabaseSync(..., { open: true, readOnly: true })`）。

### 23.2 摘要库与实测陷阱

| 字段 | 实测含义与处理 |
|---|---|
| `title` | 桌面端渲染的会话标题，作为 Tier 1 标题使用；缺失时回退首句 `<USER_REQUEST>` |
| `workspace_uris` | 工作区 URI；值为 `outside-of-project` 时归入独立聊天组 `antigravity:chats`（`Antigravity 独立聊天`） |
| `nesting_depth` / `killed` | `nesting_depth > 0`（子 agent）或 `killed = 1` 必须从会话列表与运行态字典中过滤 |
| `status` vs `not_fully_idle` | **实测典型对话已到达 `PLANNER_RESPONSE DONE` 且 `status = CASCADE_RUN_STATUS_IDLE`，但 `not_fully_idle` 仍为 `1`。** 因此只有 `status === 'CASCADE_RUN_STATUS_RUNNING'`（且 `last_modified_time` 在 30 分钟内）才判为 `busy` |
| `parent_conversation_id` | 若与当前 `conversation_id` 不同，用于关联父/子或分叉链 |

### 23.3 JSONL 转录结构与无状态 step 配对

- 每条记录含递增整数 `step_index`、`type`（`USER_INPUT` / `PLANNER_RESPONSE` / `GENERIC` / `ERROR_MESSAGE` / `CHECKPOINT` / `SYSTEM_MESSAGE`）和 `created_at`。
- `USER_INPUT.content` 以 `<USER_REQUEST>...</USER_REQUEST>` 包裹用户输入，后附 `Active Workspaces:` / `<ADDITIONAL_METADATA>` 与 `<USER_SETTINGS_CHANGE>`（记录模型切换）。
- **确定性工具配对（无状态逐行安全）**：实测 600+ 步全语料确认——当 `PLANNER_RESPONSE` 在 `step_index = S` 发起第 `i` 个 `tool_call` 时，其对应的 `GENERIC` 工具结果恒定落在 `step_index = S + 1 + i`。`antigravityEvents` 直接将第 `i` 个调用的 `tool.id` 赋为 ``step:${S + 1 + i}``，工具结果赋 `id = step:${step_index}`，使得逐行分片（`eventsFor` / `paginateEvents`）无需跨行缓存即可精确配对。
- `GENERIC` 失败判定：优先看 `r.status === 'ERROR'` 或输出正文匹配 `Command exited with code N.`（`N != 0`）。

### 23.4 运行与权限双通道

- **主通道（官方插件 Sidecar）**：Baton 在 `sidecars/baton-bridge/` 提供合法的 Antigravity 插件（包含 `bridge` sidecar，利用 Antigravity 内置 `agentapi` 暴露的 `newConversation` / `sendUserMessage`），只复制文件至 `~/.gemini/config/plugins/baton-bridge/`，**绝不触碰 `~/.gemini/config/config.json`**。Sidecar 仅监听 `127.0.0.1` 临时端口、强制 `~/.baton/token` Bearer 鉴权，并把自身 `{ pid, port, projectId }` 写入 `~/.baton/antigravity-bridges/<pid>.json`。
- **回退通道（`agy` CLI）**：`antigravity-cli/` 会话或桌面桥接未启动时回退系统 `agy` 可执行文件（`--input-format=stream-json --output-format=stream-json --print= [--conversation <id>]`）。
- 权限模式：`default` / `plan`（`--mode plan`）/ `edits`（`--mode accept-edits`）/ `bypass`（`--dangerously-skip-permissions`）。
- 思考强度：`agy.exe` 原生支持 `--effort (low|medium|high|xhigh|max)`。
- 斜杠命令与技能（`antigravityCommands`）：合并扫描 `~/.gemini/antigravity/builtin/skills/*/SKILL.md`、`~/.gemini/config/skills/*/SKILL.md`、`~/.gemini/config/plugins/*/skills/*/SKILL.md` 与工作区 `<cwd>/.agents/skills/*/SKILL.md`，以 `/` 触发（实测与 `claude` 一致支持句子中点名）。

### 23.5 `agy.exe`（v1.5.10）CLI 实测结论

2026-11-17 于本机安装官方 `agy.exe` `1.5.10`（`%LOCALAPPDATA%\agy\bin\agy.exe`，与桌面端 `%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe` 独立安装）后实测：

- **登录态复用**：`agy` CLI 直接复用 Antigravity Desktop 的凭据与扩展环境（实测 `agy plugin list` 自动看到 `baton-bridge (enabled)`，无头对话直接访问 `daily-cloudcode-pa.googleapis.com` 并返回 `SUCCESS`）。
- **`-p` / `--print` 参数陷阱**：Go `flag` 语法要求 `--print=<prompt>` 或 `-p=<prompt>`，若传 `-p --output-format stream-json` 会报错退出（`exit 2`，把 `--output-format` 吞作提示词）；不支持 `--fork`（传 `--fork` 报错）。
- **流式输入 / 输出结构（避开 Windows shell 注入）**：配合 `--input-format=stream-json --output-format=stream-json --print=` 时，可从 stdin 写入 `{"event":"user","message":{"role":"user","content":"..."}}`（`\n` 分隔 NDJSON），stdout 依次输出：
  - `{"event":"init","conversation_id":"<uuid>","init":{...}}`
  - `{"event":"step_update","step_update":{"conversation_id":"<uuid>","step_index":N,"state":"ACTIVE"|"DONE","step_type":"user_input"|"agent_response"|...,"usage":{...}}}`
  - `{"event":"result","result":{"conversation_id":"<uuid>","status":"SUCCESS"|"ERROR","response":"...","usage":{"input_tokens":...,"output_tokens":...,"cache_read_tokens":...}}}`
- **套餐额度**：见 §23.6 —— 虽无顶层 subcommand，但 `--print=/usage` 支持 0 token 返回完整 JSON 额度明细。

### 23.6 额度查询（`/usage`）与 ACP 跨端会话引擎实测

2026-11-18 深入实测 `agy.exe 1.5.10` 二进制命令与 `agy acp --stdio` 协议后完成全面升级：

1. **零开销实时套餐额度查询（`src/usage.js`）**：
   - 执行 `agy --output-format=stream-json --print-timeout=15s --print=/usage` 在 **0 轮对话、0 LLM token、不建新会话**下输出 `{"event":"command_result","command":{"name":"usage","data":{"groups":[...]}}}`。
   - 返回 **Gemini Models**（`gemini-5h` / `gemini-weekly`）与 **Claude and GPT models**（`3p-5h` / `3p-weekly`）两组的 `remaining_fraction`（换算为 Baton `used = (1 - remaining_fraction) * 100`）及 `reset_time`。
2. **ACP 权威模型目录、套餐档位与逐模型 `--effort` 约束（`src/agent/catalog.js`、`src/agent/args.js`）**：
   - `agy acp --stdio --app-data-dir=antigravity` 握手 `initialize` -> `session/list` -> `session/load`（0 轮执行、不新建会话）直接返回 `_meta.antigravity.tier.name`（实测 `"Google AI Ultra"`）、1M 上下文窗口（`usage_update.size = 1048576`）、9 个基础模型与 `availableModels` 各强度变体。
   - 实测 `agy --model pro --effort high` 报 `exit 1: --effort is not supported for model "pro"`；仅基础模型（`gemini-4-carbon`、`gemini-4-argon`、`gemini-4-hydrogen`、`gemini-3.8-flash`、`claude-opus-5-5`、`claude-sonnet-5-5`）支持按变体集合传递 `--effort`，`pro`/`flash`/`flash_lite`/Orchestrator/`gpt-oss-*` 不传 `--effort`。
   - 权限新增 `auto`（`--mode auto`），共五档：`default` / `plan` / `edits` / `auto` / `bypass`。
3. **三通道混合执行架构（`src/agent/antigravityRun.js`）**：
   - **通道 1（`baton-bridge` Sidecar）**：桌面端开启且采用默认策略继续会话时优先走本地桥接（与桌面 UI 实时同步）。
   - **通道 2（`agy acp --stdio --app-data-dir=<product>`）**：桌面端未打开、`antigravity-ide/` 会话、或明确选了 `plan` / `edits` / `auto` / `bypass` / `--effort` / 切换模型时启用，实测可经 `--app-data-dir=antigravity` 直接 `session/load` / `session/prompt` / `session/cancel` 桌面会话库（弥补顶层 `agy` 拒绝 `--app-data-dir` 的限制）。
   - **通道 3（`agy --input-format=stream-json --output-format=stream-json --print=`）**：`antigravity-cli/` 命令行原生会话与新建 CLI 会话，并在 `src/http/handlers/create.js` 补全 `event === 'init'` 的即时落地识别。



