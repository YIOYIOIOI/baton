# 工作目录选择器：给客户端的 API 契约

> 服务端已实现并通过实测（PR #7）。本文是给网页端与 iOS 端的接入说明。
>
> **三处改动全是「加字段 / 加端点」，不改任何旧结构。不接也不会坏**——只是手机上
> 选不了新目录、也建不了文件夹。
>
> 背景与决策依据见 `docs/superpowers/specs/2026-09-14-workspace-isolation-design.md`。

## 0. 先理解一件事：同一套 API，两种人

服务端现在区分**调用者身份**。同一个端点，owner 和访客拿到的东西不同：

| | owner | 访客（guest） |
|---|---|---|
| 能看到的会话 | 全部 | 只有工作区目录之下的 |
| 能浏览的目录 | 整台机器 | 只有自己的工作区之下 |
| 能新建会话的目录 | 任意已存在的绝对路径 | 只有自己的工作区之下 |

**客户端不需要知道自己是谁**，也不需要判断。照着下面的接口写，两种身份都对——
服务端已经按调用者收窄过了。不要在客户端做任何「我是不是访客」的分支。

认证沿用现有那套：网页走 cookie，原生走 `Authorization: Bearer`。没有新增。

## 1. `GET /api/sessions` 多了一个 `cwds` 字段

```diff
  {
    "chains": [ ... ],          // 原样，一个字没改
+   "cwds": ["C:\\workspace\\demo", "C:\\workspace\\baton"]
  }
```

`cwds` = **这个调用者**可选的工作目录快捷列表，已排序去重。

**为什么需要它**：两端现在都是遍历 `chains[].members[].cwd` 自己凑候选
（`app/src/app/new.tsx:48`、`src/web/app.js:393`）。那个做法对 owner 恰好等价，
但**访客零会话时会得到一个空选单，压根开不了头**。`cwds` 对访客至少含他自己的
工作区根目录。

**改法**：把新建页凑 cwd 的那几行换成直接用 `cwds`。行为对 owner 完全不变。

## 2. `GET /api/dirs` —— 浏览目录

```
GET /api/dirs              → 起点
GET /api/dirs?path=<绝对路径>  → 该目录下的子目录
```

**200 响应**：

```json
{
  "path": "C:\\workspace",
  "parent": "C:\\",
  "dirs": [
    { "name": "baton",   "path": "C:\\workspace\\baton",   "readable": true },
    { "name": "example", "path": "C:\\workspace\\example", "readable": true }
  ]
}
```

| 字段 | 含义 |
|---|---|
| `path` | 当前所在目录。**起点时为 `null`**——那是一组入口，不是某个目录的内容 |
| `parent` | 上一级的绝对路径。**为 `null` 表示不能再往上**：访客站在自己工作区根上、owner 站在盘符根上都是这样。UI 据此禁用「返回上级」 |
| `dirs[].readable` | `false` = 这个目录点进去会失败。**必须显示为不可点**，不要让用户点了才报错 |

**三条必须知道的行为**：

1. **只返回目录，不返回文件。** 这是选工作目录用的，不是文件浏览器。
2. **不带 `path` 时返回起点**：owner 得到「盘符 + 他用过的目录」，访客得到「他的工作区根」。**UI 的起点页面直接打这个，不要自己拼盘符。**
3. **隐藏目录不过滤。** `.claude` 之类会出现在列表里，那是有意的——worktree 目录是真实的工作目录。

**错误**（都是 `{ "error": { "code", "message", "fix" } }`）：

| 状态 | `code` | 什么时候 |
|---|---|---|
| 400 | `bad_path` | `path` 不是绝对路径 |
| 403 | `outside_workspace` | 访客越出自己的工作区。`fix` 里写着他的工作区在哪，**直接显示给用户** |
| 404 | `dir_not_found` | 目录不存在 |
| 403 | `dir_unreadable` | 目录存在但读不了（系统目录） |

## 3. `POST /api/dirs` —— 新建目录

```
POST /api/dirs
{ "path": "C:\\BatonWorkspaces\\friend\\newproj" }
```

| 状态 | body | 什么时候 |
|---|---|---|
| 201 | `{ "path": "...", "created": true }` | 建好了 |
| 200 | `{ "path": "...", "created": false }` | 已经存在且是目录——**不是错误**，照常往下走 |
| 403 | `send_disabled` | 只读模式。`fix` 说了怎么开 |
| 403 | `outside_workspace` | 访客越界 |
| 400 | `bad_path` / `not_a_directory` / `mkdir_failed` | 路径不合法 / 同名文件已存在 / 建不出来 |

**递归创建**，所以可以一次传多层路径。

**归在 `allowSend` 之下**——它往 owner 的磁盘上写东西，和传文件同一条纪律。
`GET /api/health` 返回的 `allowSend` 现在是**调用者自己的有效值**，UI 据此决定
「新建文件夹」按钮要不要禁用。

## 4. `POST /api/sessions` 的工作目录校验换了

旧规则是「只能选已有会话出现过的目录」。新规则：

```
绝对路径 ∧ 目录已存在 ∧ 在调用者的工作区之下（owner 不受限）
```

新的错误码，UI 要能分别处理：

| 状态 | `code` | 建议的 UI 反应 |
|---|---|---|
| 400 | `bad_cwd` | 路径不是绝对路径 |
| 403 | `cwd_not_allowed` | 访客越界，`fix` 里有他的工作区路径 |
| 400 | `cwd_not_found` | **目录不存在——这里正好可以提示「要不要建一个？」并调 `POST /api/dirs`** |

响应体里的 `cwd` 是**归一化之后**的路径，不一定与请求里的原文逐字相同。以响应为准。

## 5. 建议的界面流程

```
新建会话
  └─ 工作目录
       ├─ [快捷] GET /api/sessions 的 cwds         ← 最常用，一步到位
       └─ [浏览] GET /api/dirs 起点
             → 点目录进下一层（readable:false 的不可点）
             → parent 为 null 时禁用「上一级」
             → [新建文件夹] POST /api/dirs
```

owner 这样能走到机器上任何地方；访客走到哪都还在自己的工作区里——**同一套 UI，
不需要任何身份分支**。

## 6. 什么都不改会怎样

- 会话列表、对话、发消息、上传、切模型、推送：**全部照旧**，一个字节没变
- 新建会话页：owner 照旧能用（`cwds` 与他自己凑出来的那份等价）
- 唯一的损失：选不了新目录、建不了文件夹，访客零会话时选单是空的

---

# 追加：权限档位（`/api/permission`）

> 服务端与两端客户端已实现。**owner 专属**，访客只能读。

## 为什么有这个

Baton 每一轮都是**非交互**地起 `claude` / `codex`——没有地方弹权限对话框，
于是不在允许清单里的工具**直接被拒**，而手机上既批不了、也看不出是为什么。
owner 的原话：「以后要支持手机端更改权限，支持手机端 bypass」。

## 三档

| Baton | claude | codex |
|---|---|---|
| `default` | 不传 | 不传 |
| `edits` | `--permission-mode acceptEdits` | `--sandbox workspace-write` |
| `bypass` | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` |

参数抄自 2026-09-14 实测的 `claude --help` / `codex exec --help`。
**闭集查表**，不接受外来字符串——argv 的纪律见 `src/agent/args.js` 抬头。

`edits` 两边不完全对等：codex 的 `workspace-write` 同时把写入锁在工作区内，
claude 没有对应物。如实记下，不要当成一回事。

## 接口

```
GET  /api/permission        → { mode, canSet, modes }
POST /api/permission {mode} → 同上
GET  /api/health            → 多了 permissionMode / canSetPermissionMode
```

health 捎一份是刻意的：横幅每一屏都要挂，而 health 是各屏都会打的轻端点；
单开一次请求只为问这个，横幅会比页面晚一拍出现。

| 状态 | `code` | 什么时候 |
|---|---|---|
| 403 | `not_owner` | 访客改档 |
| 400 | `bad_mode` | 不在三档之内 |

## 为什么只有 owner 能改

**访客一旦能开 bypass，工作区隔离当场失效。** 隔离是 Baton 在自己这层按 cwd
过滤；bypass 放开的是 agent 自己的工具闸门——一个不问就能跑 shell 的 agent，
想走出工作区只需要一条 `cd`。

判据是 `principal.roots === null`，和 `scope.js` 的边界值同一个，不另立标志位：
两处事实迟早对不上，而对不上的那一刻要么访客提权、要么 owner 被锁在门外。

## 呈现在输入框那排药丸里，不做横幅

第一版在列表页/会话页/设置页顶上各挂了一条红色横幅。owner 的评价是
「bypass 不要显示在主页上，不要做这种这么明显提示，权限设置应该要放在
对话框里面」。

他是对的，理由不只是审美：**这个档位只在你要发东西的那一刻才相关**。挂在列表页
顶上，它是一条与当下无关的警告——而与当下无关的警告，看两次就不看了，等真该看
的时候它已经变成背景噪音。

现在它是输入框那排药丸里的一颗，和模型、agent、工作目录并排——它们说的是同一件
事的几个方面：**这一条消息会怎么被执行**。按下发送之前必然扫过。
`bypass` 时药丸变红，那是**状态的如实呈现**，不是警告。

两处细节：

- **排第一**。药丸行横向滚动，新建页有四颗，排后面的默认在屏幕外——
  「全放行」一旦看不见等于没做。
- **读不到时显示省略号**，不回落到「询问」。那台电脑可能正开着全放行，
  凭默认值写一个档位上去不是猜错，是撒谎。

只有 `bypass` 走二次确认。另两档可逆，给它们也配确认只会养出闭眼点「好」的
习惯，等真正危险的那次来了正好帮倒忙。

## 生效时机

档位**在起进程那一刻从盘上读**，不走 `createServer` 的 config 快照——那份是
启动时定死的，改了要重启才生效，而这个功能的全部意义就是在手机上改。
一轮可能排队等很久才真正跑起来，读得晚一点正好符合「我改完，下一轮就按新档位」。
