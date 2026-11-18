import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BATON_DIR } from '../config.js';
import { runProcess } from './spawn.js';
import { EFFORTS } from './args.js';
import { displayName } from './catalog.js';

/**
 * Claude 的「默认」到底是什么模型、什么强度——问 claude 自己，不从配置文件推。
 *
 * ## 为什么不推
 *
 * 2026-10-01 实测（claude 2.1.281），三处看着像答案的地方都不是：
 *
 *   - `~/.claude/settings.json` 的 `effortLevel: "max"`。CLI 对这个键只认
 *     low / medium / high / xhigh，别的值当没写（max 只能用在单个会话里）
 *   - 桌面 App 给它自己会话设的 `CLAUDE_EFFORT=max`。09-29 到 10-01 守护进程
 *     把它继承了下来，那几天没选强度的轮次在 transcript 里记的全是 medium
 *   - 默认模型带不带 1M 上下文，哪个配置文件里都没有，是 CLI 按版本自己定的
 *
 * 实际是 **Opus 5.5 · 1M 上下文 · medium**。而且显式选 `claude-opus-5-5` 时，
 * 请求里**没有** 1M 那一项——「默认」和列表里的「Opus 5.5」不是同一档。
 *
 * ## 怎么问
 *
 * 让 claude 起一次，把第一条请求发到本机一个假端点；从请求里读 `model`、
 * `anthropic-beta`（有没有 context-1m）、`output_config.effort`，回一个 400 就收掉。
 * **这条请求不出本机，不花钱**，也不写会话文件（`--no-session-persistence`）。
 * 整个过程实测约 4 秒。
 *
 * ## 两层保险，缺一层都可能真的发出去
 *
 * 第一次试的时候就真发出去过一次：
 *
 *   1. 地址用 `--settings` 覆盖。只改环境变量不够——`settings.json` 的 `env`
 *      里也写着 `ANTHROPIC_BASE_URL`，CLI 启动后会拿它盖掉进程环境里的值。
 *      `--settings` 的优先级比 `settings.json` 高，实测生效
 *   2. 本机以外的出站 HTTP(S) 全走一个不存在的代理（见 probeEnv）。将来哪个版本
 *      不认第 1 层，请求也出不去
 *
 * 要是还是拿到了真回答，说明两层都失效了：报出来，并且这个守护进程里不再探
 * （见 claudeDefaults）——不能每半小时悄悄花一次钱。
 */

const DEAD_PROXY = 'http://127.0.0.1:9';

function named(id, contextWindow, effort) {
  return { id, name: displayName(id), contextWindow, effort };
}

/** 从截下的那条请求里读出默认。 */
export function defaultsFromRequest({ body, beta }) {
  const id = typeof body?.model === 'string' ? body.model : null;
  if (!id) return null;
  const effort = body?.output_config?.effort;
  return named(
    id,
    // 带 context-1m 就是 1M 那一档。不带时**不猜**窗口多大
    /(^|,)\s*context-1m-/.test(beta ?? '') ? 1_000_000 : null,
    EFFORTS.includes(effort) ? effort : null,
  );
}

/**
 * init 记录里的 model，形如 `claude-opus-5-5[1m]`。
 *
 * 请求没截到时的退路（比如环境里没凭据，CLI 在发请求之前就报 Not logged in）：
 * 模型和 1M 还读得出来，强度读不出来。
 */
export function defaultsFromInit(model) {
  const m = /^(.+?)(\[1m\])?$/.exec(String(model ?? '').trim());
  if (!m) return null;
  return named(m[1], m[2] ? 1_000_000 : null, null);
}

/** 探测进程的环境。代理那几个变量 Windows 上不分大小写，旧的变体全部拿掉再设。 */
export function probeEnv(env, url) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (!/^(https?|no|all)_proxy$/i.test(k)) out[k] = v;
  }
  return {
    ...out,
    ANTHROPIC_BASE_URL: url,
    HTTPS_PROXY: DEAD_PROXY,
    HTTP_PROXY: DEAD_PROXY,
    NO_PROXY: '127.0.0.1,localhost',
  };
}

/**
 * 起一次 claude，截下它的第一条请求。
 *
 * @returns {Promise<{ value: object|null, escaped: boolean }>}
 *   `escaped` = 请求没被截住、拿到了真回答。
 */
export function probeClaudeDefaults({
  command = 'claude', prefixArgs = [], extraArgs = [], cwd = process.cwd(), env = process.env,
  timeoutMs = 60_000, dir = BATON_DIR,
  // 只要 init 那条（斜杠命令表，见 agent/commands.js）：拿到就收掉，连那条假请求都不等
  onInit = null, stopAtInit = false,
} = {}) {
  return new Promise((resolve) => {
    let handle = null;
    let settingsFile = null;
    let fromInit = null;
    let escaped = false;
    let done = false;

    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      handle?.kill();
      srv.close();
      if (settingsFile) fs.rmSync(settingsFile, { force: true });
      resolve({ value: value ?? fromInit, escaped });
    };

    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error', error: { type: 'invalid_request_error', message: 'baton probe: not forwarded' },
        }));
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {
          return;
        }
        // 只认对话那条主请求（有 messages）。别的请求照样回 400，不当成答案
        if (req.method === 'POST' && req.url.startsWith('/v1/messages') && Array.isArray(body?.messages)) {
          finish(defaultsFromRequest({ body, beta: req.headers['anthropic-beta'] }));
        }
      });
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
    srv.on('error', () => finish(null));

    srv.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address());
      const url = `http://127.0.0.1:${port}`;
      try {
        fs.mkdirSync(dir, { recursive: true });
        settingsFile = path.join(dir, `probe-settings-${process.pid}-${Date.now()}.json`);
        fs.writeFileSync(settingsFile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: url } }));
      } catch {
        finish(null);
        return;
      }
      runProcess({
        command,
        // shell:true 会把参数原样拼起来，路径要自己加引号
        args: [...prefixArgs, '-p', '--no-session-persistence', '--output-format', 'stream-json', '--verbose',
          '--settings', `"${settingsFile}"`, ...extraArgs],
        cwd,
        message: 'x',
        env: probeEnv(env, url),
        timeoutMs,
        onStart: (h) => {
          handle = h;
          if (done) h.kill(); // 进程起来之前就已经收尾了（比如超时）
        },
        onLine: (line) => {
          let r;
          try {
            r = JSON.parse(line);
          } catch {
            return;
          }
          if (r.type === 'system' && r.subtype === 'init') {
            fromInit = defaultsFromInit(r.model);
            onInit?.(r);
            if (stopAtInit) finish(null);
          }
          if (r.type === 'result' && r.is_error === false) escaped = true;
        },
      }).then(() => finish(null));
    });
  });
}

let state = { at: 0, key: null, value: null, promise: null, disabled: false };

function mtimeOf(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 带缓存的默认值。同一时刻只起一个探测进程。
 *
 * `effort` = Baton 自己给默认轮次带的强度（config.json 的 defaultEffort，见
 * runtime/prefs.js）。探测时**带上同样的参数**，报出来的才是默认那一轮真正发出去的
 * ——而不是先探 CLI 的默认、再拿配置里的值往上贴：CLI 认不认这一档，要它自己说。
 *
 * 失效：过了 ttl、`~/.claude/settings.json` 改过（模型、env 都可能写在那里）、或者
 * 默认强度改了。其它会影响默认的东西（CLI 升级、守护进程的环境）要么随 ttl 跟上，
 * 要么本来就要重启守护进程。
 *
 * @returns {Promise<{id, name, contextWindow, effort}|null>} 探不出来就是 null
 */
export function claudeDefaults({
  probe = probeClaudeDefaults, now = Date.now(), ttlMs = 30 * 60_000, effort = null,
  settingsPath = path.join(os.homedir(), '.claude', 'settings.json'),
  log = (msg) => console.log(msg),
} = {}) {
  if (probe === probeClaudeDefaults && process.env.BATON_NO_CLI_PROBES === '1') {
    return Promise.resolve(null);
  }
  if (state.disabled) return Promise.resolve(state.value);
  if (state.promise) return state.promise;
  const key = `${mtimeOf(settingsPath)}|${effort ?? ''}`;
  if (state.at && now - state.at < ttlMs && state.key === key) return Promise.resolve(state.value);

  state.promise = probe({ extraArgs: effort ? ['--effort', effort] : [] })
    .then((r) => {
      state = { at: now, key, value: r?.value ?? null, promise: null, disabled: !!r?.escaped };
      if (r?.escaped) {
        log('  ⚠ 探测 Claude 默认配置时，请求没被本机截住、拿到了真回答（花了一次钱）。'
          + '这个守护进程不再探测；检查 src/agent/defaults.js 抬头那两层保险是否还成立。');
      }
      return state.value;
    })
    .catch(() => {
      state.promise = null;
      return state.value;
    });
  return state.promise;
}

/** 仅供测试。 */
export function resetClaudeDefaults() {
  state = { at: 0, key: null, value: null, promise: null, disabled: false };
}
