import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execAgy, findAgyBinary, withAgyEnv } from './agy.js';
import { killChildTree, runBuffered } from './spawn.js';

/**
 * Codex 的**权威**模型目录。
 *
 * ## 为什么要它
 *
 * owner：「claude 和 gpt 的模型为什么是定死的？应该要做成选择现有配置里面的
 * 可选模型」。原来的做法是从 transcript 和配置里现推，实测每边只推出**两个**
 * ——跑过什么就只有什么，等于把「我最近用过的」当成了「我能用的」。
 *
 * `codex debug models` 渲染的是真实目录，11 个模型，而且带的字段正好是界面
 * 要的那几样（owner 发的 GPT App 截图里就是这么排的）：
 *
 *   slug                      进 argv 的那个名字
 *   display_name              「6 Astra」——列表里显示的
 *   description               副标题
 *   visibility                list / hide，hide 的收进「更多模型」
 *   default_reasoning_level   没选过强度时实际生效的那一档
 *   supported_reasoning_levels 这个模型能选哪几档（**逐模型不同**：
 *                             gpt-6-astra 到 ultra，gpt-5.5 封顶 xhigh）
 *
 * ## Claude 那边：原来没有，现在有了（2026-11-10 更正）
 *
 * 这里原来写的是「`~/.claude` 下没有任何模型缓存，Claude 侧只能现推 + 别名兜底」。
 * 那是旧版 Claude Code 时查的；2.1.322 已经有了自己的模型目录，`/model` 就照它列，
 * 缓存在 `~/.claude/cache/model-catalog/<组织 id>-…-cc.json`——见下面的
 * claudeCatalog 与 agent-protocol §16。没有重查就沿用旧结论，结果是 owner 发现
 * 「/model 列出来的比我们多得多」，而且别名 opus/sonnet 和具体型号并排成了重复。
 *
 * ## 为什么要剔掉 model_messages
 *
 * 原始输出 505 KB，其中绝大部分是每个模型的提示词正文（`model_messages`）。
 * 那东西对我们毫无用处，留着只会让缓存和测试夹具都膨胀几百倍。
 */

const TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 20_000;

/** 从 `codex debug models` 的 JSON 里只取我们要的字段。坏输入一律返回空表，不抛。 */
export function parseCatalog(json) {
  let o;
  try {
    o = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return [];
  }
  const list = Array.isArray(o?.models) ? o.models : [];
  const out = [];
  for (const m of list) {
    const id = m?.slug;
    if (typeof id !== 'string' || !id) continue;
    const efforts = Array.isArray(m.supported_reasoning_levels)
      ? m.supported_reasoning_levels.map((x) => x?.effort).filter((x) => typeof x === 'string')
      : [];
    out.push({
      id,
      name: typeof m.display_name === 'string' && m.display_name ? m.display_name : null,
      desc: typeof m.description === 'string' && m.description ? m.description : null,
      // 只有明确标了 hide 的才算长尾。字段缺失时按「露出来」处理——
      // 少显示一个能用的模型，比多显示一个更糟
      hidden: m.visibility === 'hide',
      efforts,
      defaultEffort: typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : null,
    });
  }
  return out;
}

/**
 * 拿目录。任何异常（没装 codex、超时、输出不是 JSON）都返回空表——
 * 这个函数是来**补充**候选模型的，不该成为一个新的故障点：
 * 拿不到目录时界面退回现推的那几个，仍然能用。
 */
export async function codexCatalog({ runtime = null, run = defaultRun } = {}) {
  try {
    return parseCatalog(await run(runtime));
  } catch {
    return [];
  }
}

function defaultRun(runtime) {
  if (process.env.BATON_NO_CLI_PROBES === '1') {
    return Promise.reject(new Error('probes disabled'));
  }
  return runBuffered('codex', ['debug', 'models'], {
    runtime,
    timeoutMs: TIMEOUT_MS,
    // 原始输出 ~505 KB，留足余量；它还会随模型数量增长
    maxBuffer: 16 * 1024 * 1024,
    unref: true,
  }).then(({ code, stdout }) => {
    if (code !== 0) throw new Error(`codex debug models 失败（exit ${code}）`);
    return stdout;
  });
}

/**
 * 从模型 id 推出显示名。
 *
 * owner 发的两张截图里，两个 App 显示的都是「Opus 5」「6 Astra」「5.6 Sol」
 * 这种名字，不是 `claude-opus-5` / `gpt-6-astra`。Codex 那边目录直接给了
 * `display_name`；Claude 没有目录，只能推。
 *
 * **是推导不是查表**——查表就又「定死」了，出一个新模型就少一个。规则：
 *
 *   去掉 claude- / gpt- 前缀        claude-opus-5     → opus 5
 *   连续的纯数字段用点接起来        claude-fable-5-1  → Fable 5.1
 *   8 位的日期段丢掉                claude-sonnet-4-5-20250929 → Sonnet 4.5
 *   其余首字母大写                  gpt-6-astra       → 6 Astra
 */
export function displayName(id) {
  const raw = String(id ?? '').trim();
  if (!raw) return '';
  const segs = raw.replace(/^(claude|gpt)-/i, '').split('-').filter(Boolean);

  const parts = [];
  let nums = [];
  const flush = () => { if (nums.length) { parts.push(nums.join('.')); nums = []; } };
  for (const s of segs) {
    if (/^\d{8}$/.test(s)) continue;            // 日期戳，对人没有意义
    if (/^[\d.]+$/.test(s)) { nums.push(s); continue; }
    flush();
    parts.push(s.charAt(0).toUpperCase() + s.slice(1));
  }
  flush();
  return parts.join(' ') || raw;
}

/**
 * Claude Code 自己的模型目录——`/model` 列出来的那张表。
 *
 * ## 从哪来（2026-11-10 实测，claude 2.1.322，详见 agent-protocol §16）
 *
 * Claude Code 从 `downloads.claude.ai/model-catalog/v1/catalog.json` 拉一份带签名的
 * 目录（按账号下发，拉不到用程序里内置的那份），落在
 * `~/.claude/cache/model-catalog/<组织 id>-<hash>-cc.json`：
 *
 *   catalog.config.models[]                 每个模型：id / name / description / section
 *                                           （main 直接露出、overflow 收进「更多」、
 *                                           deprecated 不列）/ runtime.effort_levels /
 *                                           runtime.default_effort / offered_on / disabled
 *   catalog.config.provider_alias_targets   别名指向谁：opus → claude-opus-5-5 …
 *
 * 程序里的过滤条件照抄：`disabled !== true && section !== "deprecated"`，再按
 * `offered_on` 挑这条路线供不供（直连账号是 first_party）。
 *
 * ## 为什么读缓存而不是自己去拉
 *
 * 读 agent 自己读的那一份，和 codex 那边一个道理：Claude Code 拉的是**这个账号**的目录，
 * 我们另拉一份既可能拉到别人的（没登录态），也可能跟它手上那份不同步。
 */

/**
 * 目录里的说明是英文的。认得的几句换成中文，认不得的**原样**给——
 * 新模型的说明总会先于这张表出现，原文比空白强。
 */
const ZH = new Map([
  ['For complex work and everyday tasks', '复杂的活、日常的活都行'],
  ['Most efficient for simpler tasks', '简单的活用它最省'],
  ['For your toughest challenges', '最难的活交给它'],
  ['Fastest for quick answers', '最快，适合快问快答'],
  ['Most capable for your hardest and longest-running tasks', '最强，适合最难、最久的活'],
  ['Fable is the most capable model and draws down usage much faster than Opus', '耗额度比 Opus 快得多'],
]);
const zh = (s) => (typeof s === 'string' && s.trim() ? ZH.get(s.trim()) ?? s.trim() : null);

/**
 * 从 Claude Code 的目录缓存里取我们要的。坏输入返回 null，不抛。
 *
 * @param {unknown} json  缓存文件内容（字符串或已解析的对象）
 * @param {{ provider?: string }} [opts]  路线：直连账号是 first_party
 * @returns {{ models: Array<{ id: string, name: string, desc: string|null, hidden: boolean,
 *   efforts: string[], defaultEffort: string|null }>, aliases: Record<string, string> } | null}
 */
export function parseClaudeCatalog(json, { provider = 'first_party' } = {}) {
  let o;
  try {
    o = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return null;
  }
  const config = o?.catalog?.config;
  if (!config || !Array.isArray(config.models)) return null;

  const models = [];
  for (const m of config.models) {
    const id = m?.id;
    if (typeof id !== 'string' || !id) continue;
    if (m.disabled === true || m.section === 'deprecated') continue;
    if (Array.isArray(m.offered_on) && !m.offered_on.includes(provider)) continue;
    const rt = m.runtime ?? {};
    // thinking.type === 'none'（Haiku 4.5）= 不能调强度。空表在这里是**确知没有**，
    // 不是「不知道」——界面据此把强度那一组收起来，而不是退回五档
    const efforts = m.thinking?.type === 'none' || !Array.isArray(rt.effort_levels)
      ? []
      : rt.effort_levels.filter((e) => typeof e === 'string');
    const ctx = Number(rt.max_input_tokens) || null;
    const desc = [
      zh(m.description),
      zh(m.notice?.text),
      m.thinking?.type === 'none' ? '不能调思考强度' : null,
      // 现在的模型都是 1M；只有比它小的才值得说一句
      ctx && ctx < 1_000_000 ? `${Math.round(ctx / 1000)}K 上下文` : null,
    ].filter(Boolean).join(' · ') || null;
    models.push({
      id,
      name: typeof m.name === 'string' && m.name ? m.name : displayName(id),
      desc,
      hidden: m.section === 'overflow',
      efforts,
      defaultEffort: typeof rt.default_effort === 'string' ? rt.default_effort : null,
      // 上下文窗口。右侧「会话信息」算「上下文用了多少」要用（sessioninfo.js）
      contextWindow: ctx,
    });
  }

  /** @type {Record<string, string>} */
  const aliases = {};
  for (const [alias, t] of Object.entries(config.provider_alias_targets ?? {})) {
    const target = t?.per_provider?.[provider] ?? t?.default;
    if (typeof target === 'string' && target.trim()) aliases[alias] = target.trim();
  }
  return { models, aliases };
}

/**
 * 读这台电脑上 Claude Code 的目录缓存。没有（旧版 Claude Code、从没登录过）返回 null。
 *
 * 一个组织一份文件，文件名以组织 id 开头。挑**当前登录那个组织**的
 * （`~/.claude.json` 的 oauthAccount.organizationUuid）；对不上就取最新的一份。
 */
export function claudeCatalog({ home = os.homedir(), configDir = null, provider = 'first_party' } = {}) {
  const baseDir = configDir || path.join(home, '.claude');
  const dir = path.join(baseDir, 'cache', 'model-catalog');
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('-cc.json'));
  } catch {
    return null;
  }
  if (names.length === 0) return null;

  let org = null;
  try {
    org = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'))?.oauthAccount?.organizationUuid ?? null;
  } catch {
    // 读不到就按最新的挑
  }
  const mtime = (n) => {
    try {
      return fs.statSync(path.join(dir, n)).mtimeMs;
    } catch {
      return 0;
    }
  };
  const pick = (org && names.find((n) => n.startsWith(`${org}-`)))
    || names.sort((a, b) => mtime(b) - mtime(a))[0];
  try {
    return parseClaudeCatalog(fs.readFileSync(path.join(dir, pick), 'utf8'), { provider });
  } catch {
    return null;
  }
}

/* ── Antigravity：ACP session/load + agy models ───────────────────────────── */

const AG_EFFORTS_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const AG_CTX_WINDOW = 1_048_576;

let agCache = null;
let agProbing = null;
let agLastTier = null;

/** 最近一次通过 ACP 握手里读到的 Antigravity 订阅套餐名（如 `Google AI Ultra`）。 */
export function antigravityTier() {
  return agLastTier;
}

/** 非阻塞返回上次已缓存的 Antigravity 目录（供 discoverModels 零延迟使用）。 */
export function cachedAntigravityCatalog() {
  return agCache?.value ?? null;
}

/**
 * 解析 `agy acp` `session/load` 返回的权威模型与思考强度配置。
 * @param {any} result
 */
export function parseAntigravityAcpLoad(result) {
  const configOpts = Array.isArray(result?.configOptions) ? result.configOptions : [];
  const modelOpt = configOpts.find((c) => c?.id === 'model');
  if (!Array.isArray(modelOpt?.options)) return null;

  const thoughtOpt = configOpts.find((c) => c?.id === 'thought_level');
  const defaultThought = typeof thoughtOpt?.currentValue === 'string' ? thoughtOpt.currentValue : null;
  const variantSet = new Set(
    (Array.isArray(result?.models?.availableModels) ? result.models.availableModels : [])
      .map((m) => m?.modelId)
      .filter((s) => typeof s === 'string'),
  );

  const models = [];
  for (const opt of modelOpt.options) {
    const id = opt?.value;
    if (typeof id !== 'string' || !id) continue;
    const name = typeof opt?.name === 'string' && opt.name ? opt.name : displayName(id);
    const efforts = AG_EFFORTS_ORDER.filter((e) => variantSet.has(`${id}-${e}`));
    const defaultEffort = defaultThought && efforts.includes(defaultThought) ? defaultThought : null;
    models.push({
      id,
      name,
      desc: efforts.length ? null : '固定思考档位',
      hidden: false,
      efforts,
      defaultEffort,
      contextWindow: AG_CTX_WINDOW,
    });
  }
  if (!models.length) return null;

  const curId = typeof modelOpt.currentValue === 'string' ? modelOpt.currentValue : null;
  const curModel = curId ? models.find((m) => m.id === curId) : null;
  const tier = typeof result?._meta?.antigravity?.tier?.name === 'string' && result._meta.antigravity.tier.name
    ? result._meta.antigravity.tier.name
    : null;

  return {
    models,
    defaultModel: curModel
      ? { id: curModel.id, name: curModel.name, contextWindow: AG_CTX_WINDOW, effort: curModel.defaultEffort }
      : null,
    effort: defaultThought,
    contextWindow: AG_CTX_WINDOW,
    tier,
  };
}

/**
 * 解析 `agy models`（制表符分隔 `id\t显示名`），将带多档 `-(low|medium|high|xhigh|max)` 后缀的
 * 变体归并为基础模型 + `efforts` 列表；单档或命名固定档位的模型保留原 id 与 `efforts: []`。
 */
export function parseAntigravityModels(stdout) {
  const raw = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    const id = parts[0]?.trim();
    if (!id || /\s/.test(id)) continue;
    const name = parts[1]?.trim() || displayName(id);
    raw.push({ id, name });
  }
  if (!raw.length) return null;

  const suffixRe = /^(.*)-(low|medium|high|xhigh|max)$/;
  const prefixMap = new Map();
  for (const item of raw) {
    const m = suffixRe.exec(item.id);
    if (!m) continue;
    const [, base, lvl] = m;
    if (!prefixMap.has(base)) prefixMap.set(base, []);
    prefixMap.get(base).push({ lvl, name: item.name });
  }

  const emitted = new Set();
  const models = [];
  for (const item of raw) {
    const m = suffixRe.exec(item.id);
    if (m) {
      const base = m[1];
      const group = prefixMap.get(base);
      if (group && group.length >= 2) {
        if (emitted.has(base)) continue;
        emitted.add(base);
        const lvls = new Set(group.map((g) => g.lvl));
        const efforts = AG_EFFORTS_ORDER.filter((e) => lvls.has(e));
        const cleanName = group[0].name.replace(/\s*\((?:Low|Medium|High|XHigh|Max)\)\s*$/i, '').trim() || base;
        models.push({
          id: base,
          name: cleanName,
          desc: null,
          hidden: false,
          efforts,
          defaultEffort: null,
          contextWindow: AG_CTX_WINDOW,
        });
        continue;
      }
    }
    if (emitted.has(item.id)) continue;
    emitted.add(item.id);
    models.push({
      id: item.id,
      name: item.name,
      desc: '固定思考档位',
      hidden: false,
      efforts: [],
      defaultEffort: null,
      contextWindow: AG_CTX_WINDOW,
    });
  }
  return {
    models,
    defaultModel: null,
    effort: null,
    contextWindow: AG_CTX_WINDOW,
    tier: null,
  };
}

function probeAntigravityViaAcp({ agyBin, product = 'antigravity', cwd = process.cwd(), env = process.env, timeoutMs = 12_000 }) {
  return new Promise((resolve) => {
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(agyBin);
    const cmd = useShell && /\s/.test(agyBin) ? `"${agyBin}"` : agyBin;
    const child = spawn(cmd, ['acp', '--stdio', `--app-data-dir=${product}`], {
      env: withAgyEnv(env),
      shell: useShell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(process.platform !== 'win32' ? { detached: true } : {}),
    });

    let settled = false;
    let buf = '';
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killChildTree(child);
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();

    const send = (obj) => {
      try {
        child.stdin?.write(`${JSON.stringify(obj)}\n`);
      } catch {
        // 已退出
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', id: 2, method: 'session/list', params: {} });
        } else if (msg.id === 2) {
          const first = Array.isArray(msg.result?.sessions) ? msg.result.sessions[0] : null;
          if (!first?.sessionId) {
            finish(null);
            return;
          }
          const loadCwd = first.cwd && !first.cwd.startsWith('/') && fs.existsSync(first.cwd) ? first.cwd : cwd;
          send({
            jsonrpc: '2.0',
            id: 3,
            method: 'session/load',
            params: { sessionId: first.sessionId, cwd: loadCwd, mcpServers: [] },
          });
        } else if (msg.id === 3) {
          finish(msg.result ? parseAntigravityAcpLoad(msg.result) : null);
          return;
        }
      }
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    child.stdin?.on('error', () => {});
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'baton', version: '0.2.0' } },
    });
  });
}

async function defaultAntigravityFetch({ env = process.env } = {}) {
  if (env.BATON_NO_CLI_PROBES === '1') return null;
  const agyBin = findAgyBinary({ env });
  if (!agyBin) return null;

  for (const product of ['antigravity', 'antigravity-cli', 'antigravity-ide']) {
    const acp = await probeAntigravityViaAcp({ agyBin, product, env });
    if (acp?.models?.length) return acp;
  }

  const r = await execAgy(['models'], { agyBin, env, timeoutMs: 20_000 });
  if (r.code === 0 && r.stdout) return parseAntigravityModels(r.stdout);
  return null;
}

/** 读并缓存 Antigravity 权威模型目录（10 分钟 TTL；拿不到时返回 null，不影响界面退回默认档）。 */
export async function antigravityCatalog({
  now = Date.now(), run = defaultAntigravityFetch, ttlMs = TTL_MS, force = false,
} = {}) {
  if (!force && agCache && now - agCache.at < ttlMs) return agCache.value;
  if (agProbing) return agProbing;

  agProbing = (async () => {
    let value = null;
    try {
      value = await run();
    } catch {
      value = null;
    }
    if (value?.tier) agLastTier = value.tier;
    if (value?.models?.length) agCache = { at: Date.now(), value };
    return value;
  })().finally(() => {
    agProbing = null;
  });
  return agProbing;
}

export function clearAntigravityCatalogCache() {
  agCache = null;
  agProbing = null;
  agLastTier = null;
}
