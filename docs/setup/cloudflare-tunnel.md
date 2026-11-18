# 用 Cloudflare Tunnel 把 Baton 接到公网

Baton 跑在你自己的电脑上，手机要能连到它。这份文档讲怎么用 Cloudflare Tunnel 做到，
**不需要公网 IP、不需要路由器端口映射、在公司网和 NAT 后面都能用**。

> 这是**给任何人照做的安装指南**。本指南演示标准通用步骤，按你的域名与本机端口调整即可。

---

## 为什么是隧道，不是端口映射

| | 端口映射 / DDNS | Cloudflare Tunnel |
|---|---|---|
| 公网 IP | 必须有 | 不需要 |
| 路由器 | 要能改配置 | 不用碰 |
| 公司网 / 运营商 NAT | 基本不可行 | 可行 |
| 入站端口 | 要开放 | **一个都不开**（隧道是出站连接） |
| 证书 | 自己搞 | Cloudflare 签好的 HTTPS |

隧道的工作方式是：你机器上的 `cloudflared` **主动向外**连到 Cloudflare，
Cloudflare 把访问 `你的域名` 的请求顺着这条既有连接送回来。
防火墙上不需要开任何入站端口。

---

## 你需要准备

1. **一个域名**，且已托管在 Cloudflare（免费套餐够用）。
   还没有的话：在 Cloudflare 注册/转入域名，或买一个便宜后缀，把 NS 指过去。
2. **Cloudflare 账号**（免费）。
3. Baton 已经能在本机跑起来：`npm start` 之后 `http://127.0.0.1:3002` 有响应。

---

## 一、装 cloudflared

**Windows**

```bash
winget install --id Cloudflare.cloudflared
```

或从 [GitHub releases](https://github.com/cloudflare/cloudflared/releases) 下 `cloudflared-windows-amd64.exe`，
改名成 `cloudflared.exe` 放进 `PATH` 里的任意目录。

**macOS**

```bash
brew install cloudflared
```

**Linux（Debian/Ubuntu）**

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
```

验证：

```bash
cloudflared --version
```

> 本文档按 `cloudflared 2026.8.3` 写。子命令多年未变，老版本大概率也适用。

---

## 二、登录

```bash
cloudflared tunnel login
```

浏览器会打开，选你要用的域名并授权。成功后本机会多出一个
`~/.cloudflared/cert.pem`（Windows 上是 `C:\Users\<你>\.cloudflared\cert.pem`）。

> **`cert.pem` 是密钥**，能代表你操作这个域名下的隧道。别提交、别外发。

---

## 三、建隧道

```bash
cloudflared tunnel create Baton
```

输出里会给一个 UUID，同时在 `~/.cloudflared/` 下生成 `<UUID>.json`——
**那是这条隧道的凭据文件，同样是密钥，永不进仓库。**

记下 UUID，下一步要用。忘了可以随时查：

```bash
cloudflared tunnel list
```

---

## 四、写配置

新建 `~/.cloudflared/config.yml`：

```yaml
# 隧道 id 或名字都行，写 id 更不容易因为改名出问题
tunnel: 把上一步的-UUID-填这里
credentials-file: /home/你/.cloudflared/把上一步的-UUID-填这里.json

ingress:
  # 把这个域名的请求送到本机的 Baton
  - hostname: baton.你的域名.com
    service: http://127.0.0.1:3002

  # 兜底规则**必须放在最后**，而且必须有。
  # ingress 是自上而下第一条匹配就生效，兜底放前面会吞掉它后面的所有规则。
  - service: http_status:404
```

Windows 上路径用反斜杠：

```yaml
credentials-file: C:\Users\你\.cloudflared\<UUID>.json
```

改完先校验，别直接重启：

```bash
cloudflared tunnel ingress validate
```

它会告诉你规则是否合法、兜底是不是在最后。

**想查某个 URL 会命中哪条规则：**

```bash
cloudflared tunnel ingress rule https://baton.你的域名.com/api/health
```

### 一条隧道挂多个服务

同一条隧道可以同时转发多个域名，按顺序往 `ingress` 里加就行：

```yaml
ingress:
  - hostname: baton.你的域名.com
    service: http://127.0.0.1:3002
  - hostname: 别的.你的域名.com
    service: http://127.0.0.1:3001
  - service: http_status:404
```

> ⚠️ 如果这条隧道**还转着别人的服务**，改配置和重启 cloudflared 会一并影响它们。
> 动手前先看清 `ingress` 里有几条。

---

## 五、建 DNS 记录

```bash
cloudflared tunnel route dns Baton baton.你的域名.com
```

这条命令在 Cloudflare 上建一条指向隧道的 CNAME。你也可以在 Cloudflare 面板里手动建，
但用命令不会填错目标。

验证（此时 cloudflared 还没跑，应该拿到 **1033**）：

```bash
curl -sSI https://baton.你的域名.com/
```

---

## 六、跑起来

```bash
cloudflared tunnel --no-autoupdate run Baton
```

`--no-autoupdate` 是为了避免它半夜自己更新后重启，把手机上正连着的流断掉。
更新交给你自己按节奏做。

另开一个终端确认：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://baton.你的域名.com/
# 期望 200
curl -sSI https://baton.你的域名.com/api/sessions | head -1
# 期望 401 —— 未配对时 Baton 自己的认证挡住了，这是对的
```

**两条都对上，就通了。** 手机上打开 `https://baton.你的域名.com/`，
按屏幕提示配对即可。

---

## 七、开机自启

隧道和 Baton 都得在电脑开机后自己起来，否则手机连不上。

**Windows —— 装成服务（推荐）**

```bash
cloudflared service install
```

管理员权限运行。它会读 `~/.cloudflared/config.yml` 并注册成 Windows 服务。

**Windows —— 组策略禁止建服务/计划任务时**

有些公司电脑上 `sc create`、`schtasks /Create`、`Register-ScheduledTask` 都会返回
`0x80070005`（拒绝访问）。这时候「启动」文件夹是唯一可行的路：

1. `Win+R` 输入 `shell:startup` 打开启动文件夹
2. 建一个指向 `cloudflared.exe` 的快捷方式，参数填
   `tunnel --no-autoupdate run Baton`
3. Baton 自己不用手建：`pwsh -NoProfile -File scripts\install-autostart.ps1`
   会建好 `Baton Daemon.lnk`（指向 pwsh 7 跑 `scripts\start-daemon.ps1`）

> Baton 的 agent 凭据在**用户级环境变量**里，而一个进程拿不拿得到它们，取决于
> 是谁把它拉起来的——从剥离了环境变量的宿主里启动，每一轮都会以「未登录」失败。
> 所以 `start-daemon.ps1` 不赌继承：它从注册表的用户作用域显式读一遍再注入。
> 仓库早期那个依赖继承的 `.cmd` 启动器，留下的两次启动记录都缺这个变量。

**macOS**

```bash
sudo cloudflared service install
```

**Linux（systemd）**

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

---

## 八、怎么判断是哪一环坏了

出问题时，**先看状态码，它能直接定位到环节**：

| 你看到 | 含义 | 去哪儿修 |
|---|---|---|
| **1033** | DNS 记录在，但**没有隧道连着** | cloudflared 没跑起来，或跑的是别的隧道 |
| **502** | 隧道**通着**，但本机那个端口没人应答 | Baton 没跑，或端口不是 `config.yml` 里写的那个 |
| **404** | 请求落到了兜底规则 | `hostname` 拼错，或 ingress 顺序错（兜底跑到前面去了） |
| **530 / DNS 解析失败** | 根本没有 DNS 记录 | 回到第五步 |
| **200，但页面不是 Baton** | 你连到了别的东西 | 公司网的强制门户、或 ingress 指错了端口 |
| **401**（`/api/*`） | ✅ **正常**。Baton 未配对时就该这样 | 不用修，去配对 |

Baton 给**自己发出的每一个响应**都带一个 `X-Baton: 1` 头，就是为了把
「Baton 说的话」和「中间设备说的话」分开：

```bash
curl -sSI https://baton.你的域名.com/api/health | grep -i x-baton
```

**有这个头** = 请求确实到达了你的 Baton。
**没有** = 你看到的 200 是别人给的（门户、缓存、Cloudflare 的错误页）。

---

## 九、换一台电脑

域名是指向**隧道**的，隧道是绑在**某台机器的凭据文件**上的。换机器有两条路：

**A. 把同一条隧道搬过去**（保留域名，最省事）

1. 旧机器：停掉 cloudflared
2. 把 `~/.cloudflared/` 下的 `cert.pem`、`<UUID>.json`、`config.yml` 拷到新机器同一位置
   （这几个是密钥，用安全的方式传）
3. 新机器：装 cloudflared，起 Baton，再 `cloudflared tunnel --no-autoupdate run Baton`
4. DNS 不用动——它指的是隧道 id，隧道换了宿主机它不关心

> 同一条隧道**不要在两台机器上同时跑**。cloudflared 允许多连接，Cloudflare 会把
> 请求分发到任意一端，结果是一半请求打到没有 Baton 的那台，随机 502。

**B. 新机器建新隧道**（更干净）

1. 在新机器上重做第二到第六步，隧道起个新名字
2. `cloudflared tunnel route dns <新隧道名> baton.你的域名.com`
   —— 同名 DNS 记录会被指向新隧道
3. 旧机器上停掉 cloudflared，并 `cloudflared tunnel delete <旧隧道名>`

两种都做完之后，**手机要重新配对**：Baton 的凭据是每台机器各自生成的，不跟着域名走。

---

## 十、安全上要知道的几件事

**Cloudflare 看得到明文。** 隧道在 Cloudflare 边缘解密再重新加密到你的机器，
所以中间那一段它是能看到内容的。这是所有反向代理型隧道的共同性质，不是配置问题。
不接受的话只有端到端加密能解，而那要改变 Baton 的架构。

**域名对任何知道它的人可达。** 隧道不带访问控制。挡住陌生人的是 **Baton 自己那层认证**：
未配对的请求一律 401，配对要 12 位一次性码（10 分钟有效），失败会限流并锁定。

**想再加一层，用 Cloudflare Access**（Zero Trust → Access → Applications）。
它能在请求到达你机器之前就要求邮箱验证。代价：
- Access 用 302 跳转做认证，**原生 app 的 fetch 不一定跟得动**（本项目就因此撤掉了它）
- 多一个登录步骤

浏览器/PWA 场景下 Access 是值得的；原生客户端要先验证它不会挡住你的请求。

**隧道下的限流看起来"坏了"，其实是对的。** cloudflared 和 Baton 在同一台机器上，
所以 Baton 看到的客户端 IP **恒为 `127.0.0.1`**——所有公网流量共用一个限流桶。
这意味着攻击者换 IP 绕不过限流，比按真实 IP 限流**更强**。
代价是他能把配对入口压在 429 让你一分钟内进不去。

> **不要改成信任 `CF-Connecting-IP`。** 那个头是客户端可写的：只要有人能直连到
> 本机端口（局域网内，或将来某次 ingress 配错），他就能每个请求换一个假 IP，
> 把唯一的桶变成无限个桶。

**这几个文件是密钥，永不进仓库：**

```
~/.cloudflared/cert.pem
~/.cloudflared/<UUID>.json
~/.baton/token
```

---

## 相关文档

- [`docs/ops/agent-protocol.md`](../ops/agent-protocol.md) —— agent CLI 的输出协议与陷阱
- [Cloudflare Tunnel 官方文档](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
