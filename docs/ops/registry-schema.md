# 桌面 App 注册项字段

> 2026-09-10 从真实注册表模板导出。位置：
> `%LOCALAPPDATA%\Claude-3p\claude-code-sessions\<account>\<org>\local_<cliSessionId>.json`
>
> **最小必需字段集未知**（设计文档 §17 已知限制 2）。Baton 的做法是以现有条目为模板复制，
> 只改确知语义的那 10 个字段，其余照抄。本文档是将来「脱离模板独立生成」时的原始材料。
>
> 实测：活动目录 85 条（另有 3 条在 `*.backup-*` 目录，`cliSessionId` 与活动目录重复，
> 必须跳过，否则得到重复身份）。模板共 27 个字段。

| 字段 | 类型 | Baton 处置 | 模板样例值 |
|---|---|---|---|
| `alwaysAllowedReasons` | array[0] | 照抄模板 | {0 键} |
| `chromePermissionMode` | string | 照抄模板 | "skip_all_permission_checks" |
| `classifierSummaryEnabled` | boolean | 照抄模板 | false |
| `cliBinaryPin` | object | 照抄模板 | {3 键} |
| `cliSessionId` | string | **Baton 改写** | "551896d4-ae47-4585-9a08-719b00870515" |
| `completedTurns` | number | 照抄模板 | 56 |
| `createdAt` | number | **Baton 改写** | 1788402483530 |
| `cwd` | string | **Baton 改写** | "C:\\workspace\\example" |
| `effort` | string | 照抄模板 | "max" |
| `enabledMcpTools` | object | 照抄模板 | {2 键} |
| `isArchived` | boolean | **Baton 改写** | false |
| `lastActivityAt` | number | **Baton 改写** | 1788839763265 |
| `lastFocusedAt` | number | **Baton 改写** | 1788858953976 |
| `lastSpawnRootDetected` | boolean | 照抄模板 | false |
| `model` | string | 照抄模板 | "claude-opus-5" |
| `originCwd` | string | **Baton 改写** | "C:\\workspace\\example" |
| `permissionMode` | string | 照抄模板 | "bypassPermissions" |
| `promptAppendSnapshot` | object | 照抄模板 | {4 键} |
| `remoteControlAutoEligible` | boolean | 照抄模板 | false |
| `remoteMcpServersConfig` | array[0] | 照抄模板 | {0 键} |
| `reportFindingsCard` | boolean | 照抄模板 | true |
| `sessionId` | string | **Baton 改写** | "local_03bacac3-2c65-4955-8dcb-af48b990305 |
| `sessionPermissionUpdates` | array[0] | 照抄模板 | {0 键} |
| `spawnSeed` | object | 照抄模板 | {0 键} |
| `title` | string | **Baton 改写** | "Codex thread topic search" |
| `titleSource` | string | **Baton 改写** | "auto" |
| `writtenBranches` | array[1] | 照抄模板 | {1 键} |

## 另外两个字段（模板里没有，但分叉产生的条目会有）

| 字段 | 说明 |
|---|---|
| `forkedFromSessionId` | 分叉来源会话 id。**Baton 新建会话时必须删除**，留着会让 App 误以为它有来源 |
| `forkedAtMessageUuid` | 从哪条消息分叉。同上，必须删除 |

## 值得注意的字段

- `remoteControlAutoEligible` —— App 自己也有 Remote Control 的概念（设计文档 §2.6：该功能在本机因无账号凭据不可用）
- `completedTurns` —— App 侧的轮次计数。照抄模板意味着新会话会带着模板的计数，语义上不准；
  若将来发现它影响 App 行为，这是第一个该改的字段
- `promptAppendSnapshot` / `cliBinaryPin` / `spawnSeed` —— 语义不明，照抄
- `permissionMode: "bypassPermissions"` —— 模板来自用户当前设置。将来做 guest 时，
  这里必须按调用者降级（设计文档 §5.5）

## 生效条件

写入后**必须重启 Claude App** 才能看到——它只在启动时加载注册表（设计文档 §11）。
