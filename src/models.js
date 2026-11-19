import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { codexCatalog, claudeCatalog, cachedAntigravityCatalog, displayName } from './agent/catalog.js';
import { EFFORTS } from './agent/args.js';
import { codexRuntime } from './agent/codexRuntime.js';

/**
 * 可选模型从**这台机器自己**推出来，不写死一张表。
 *
 * Codex 优先使用当前 CLI 的目录；配置和会话记录补充候选，但历史模型不代表当前账号可用。
 * Claude 按当前登录或中转配置筛选，见 claudeRoute。目录不完整时仍允许手输模型名。
 */

// 模型名的合法字符集与 agent/args.js 的 assertModel 保持一致。
// 这里再挡一道是因为来源是磁盘上的文件（transcript、config.toml），
// 而这些名字最终要进 argv——脏数据不能靠下游兜底。
const NAME = /^[A-Za-z0-9._-]{1,64}$/;

// 这些不是可选模型，是标记，混进列表会让人选中一个必然失败的值：
//   <synthetic>        Claude Code 给合成消息（编译错误提示等）打的标，本就不合法
//   codex-auto-review  guardian_review 内部用的评审模型，不接受对话
const NOT_SELECTABLE = new Set(['<synthetic>', 'codex-auto-review', 'none', 'auto']);

const ok = (m) => typeof m === 'string' && NAME.test(m) && !NOT_SELECTABLE.has(m);

function safeRead(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function codexTopLevel(toml) {
  return String(toml ?? '').split(/^\s*\[/m, 1)[0];
}

/** 从 Codex 配置中读取顶层 model / review_model。 */
export function modelsFromCodexConfig(toml) {
  const out = [];
  for (const line of codexTopLevel(toml).split('\n')) {
    const m = /^\s*(?:model|review_model)\s*=\s*(["'])(.*?)\1/.exec(line);
    if (m && ok(m[2])) out.push(m[2]);
  }
  return out;
}

/**
 * 这台电脑上 codex 的**生效配置**：思考强度与上下文窗口。
 *
 * owner 划的产品边界：
 *
 *   我们产品是直接复用用户的配置，用户自己模型有问题和我们的产品没关系，
 *   我们只要保证正确读取用户的模型配置、思考强度、上下文窗口这些就可以了
 *
 * 所以读的是 **agent 自己会读的那一份**——`~/.codex/config.toml`。不去读外部
 * 供应商切换器的数据库：那里面躺着的是未启用的备份配置，
 * 而 codex 运行时只认 config.toml。读数据库等于告诉用户一件不会发生的事。
 * （而且那张表里同时存着 API 密钥，能不碰就不碰。）
 *
 * 拿不到就返回 null——**不猜**。「没配置」和「配了正好等于默认」在界面上该显示
 * 得不一样：前者说「跟默认走」，后者要把那个值报出来。
 */
export function codexPrefsFromConfig(toml) {
  /*
    只读**顶层**：TOML 的顶层键必须写在第一张表（`[...]`）之前。`model` 这种键
    常常也出现在 `[profiles.x]` 里，那只在选了那个 profile 时才生效——整份文件里
    找第一个匹配，会把它当成默认报出去。（`profile = "x"` 选中 profile 的情况
    这里不处理：本机没用，用了的话如实报顶层那份，不猜。）
  */
  const text = codexTopLevel(toml);
  const str = (key) => {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(["'])(.*?)\\1`, 'm').exec(text);
    return match?.[2] ?? null;
  };
  const num = (key) => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const effort = str('model_reasoning_effort');
  const model = str('model');
  return {
    // 没选模型时 codex 实际用的那个。界面上「默认」要能说出它是谁
    model: ok(model) ? model : null,
    // 只认闭集里的值。配错了的话如实当成「没配」——报一个 agent 不认识的档位
    // 比不报更糟，人会以为它生效了
    effort: EFFORTS.includes(effort) ? effort : null,
    contextWindow: num('model_context_window'),
  };
}

/** `~/.claude/settings.json` 里 owner 自己填的自定义模型项。 */
export function modelsFromClaudeSettings(json) {
  let o;
  try {
    o = JSON.parse(String(json ?? ''));
  } catch {
    return [];
  }
  const env = o?.env ?? o ?? {};
  const out = [];
  for (const k of ['ANTHROPIC_CUSTOM_MODEL_OPTION', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL']) {
    if (ok(env[k])) out.push(env[k]);
  }
  return out;
}

/**
 * 从一段 jsonl 里挖模型名。
 *
 * 只认这几个位置，且**一找到就停**：模型名在几乎每条 assistant 记录上都有，
 * 整文件扫完只是把同一个名字数几万遍。实测单个 Claude transcript 可达 39165 次命中。
 */
export function modelsFromTranscript(text, { limit = 400 } = {}) {
  const found = new Set();
  let n = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (++n > limit) break;
    if (!line.includes('model')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // 坏行跳过
    }
    for (const m of [o?.message?.model, o?.payload?.model, o?.model, o?.payload?.info?.model]) {
      if (ok(m)) found.add(m);
    }
  }
  return [...found];
}

/**
 * @param {string} dir
 * @param {{ max: number, skip?: (p: string) => boolean }} opts
 */
function newestFiles(dir, { max, skip = () => false }) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.jsonl') && !skip(p)) {
        try {
          out.push({ p, mtime: fs.statSync(p).mtimeMs });
        } catch {
          // 刚被删掉，跳过
        }
      }
    }
  };
  walk(dir, 0);
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, max).map((x) => x.p);
}

/**
 * 扫最近若干个会话文件取模型名。
 *
 * `files` 上限压得很低（默认 10）：这是给 UI 填下拉框用的，不是做统计。
 * 最近 10 个会话覆盖不到的模型，本来也不该出现在「常用」里。
 */
const SCAN_WINDOW_BYTES = 256 * 1024;

function readBoundedSample(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= SCAN_WINDOW_BYTES * 2) {
      const buf = Buffer.alloc(size);
      const n = fs.readSync(fd, buf, 0, size, 0);
      return buf.toString('utf8', 0, n);
    }
    const head = Buffer.alloc(SCAN_WINDOW_BYTES);
    const tail = Buffer.alloc(SCAN_WINDOW_BYTES);
    const hn = fs.readSync(fd, head, 0, SCAN_WINDOW_BYTES, 0);
    const tn = fs.readSync(fd, tail, 0, SCAN_WINDOW_BYTES, size - SCAN_WINDOW_BYTES);
    return `${head.toString('utf8', 0, hn)}\n${tail.toString('utf8', 0, tn)}`;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * @param {string} dir
 * @param {{ max?: number, skip?: (p: string) => boolean, readFile?: (p: string) => string }} [opts]
 */
export function scanRecent(dir, { max = 10, skip, readFile = readBoundedSample } = {}) {
  const counts = new Map();
  for (const f of newestFiles(dir, { max, skip })) {
    let text;
    try {
      text = readFile(f);
    } catch {
      continue;
    }
    for (const m of modelsFromTranscript(text)) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

let cache = null;
let pendingCatalog = null;

function fileStamp(file) {
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false, bigint: true });
    return stat ? `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : '';
  } catch {
    return '';
  }
}

function providerFingerprint(env, toml) {
  const names = new Set(Object.keys(env).filter((name) => /^(OPENAI_|CODEX_API_KEY$)/i.test(name)));
  for (const match of toml.matchAll(/^\s*env_key\s*=\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/gm)) names.add(match[1]);
  return createHash('sha256').update(JSON.stringify([toml, ...[...names].sort().map((name) => [name, env[name]])])).digest('hex');
}

/**
 * Claude 这一轮打到哪儿：`official`（账号登录，直连 Anthropic）或 `relay`（中转）。
 *
 * 看的是 `ANTHROPIC_BASE_URL`，`settings.json` 的 `env` 优先于进程环境——CLI
 * 启动后会拿前者盖掉后者（agent/defaults.js 抬头有实测）。
 *
 * 为什么要分：「跑过」只证明**当时那个供应商**认这个名字。2026-10 这台机器走中转时，
 * 中转把 Claude Code 的请求转给过 k3 / kimi-k3.1-pro / gpt-6-astra（transcript 里
 * 消息 id 是 `chatcmpl-…` / `resp_…`，不是 Anthropic 的）；11-03 换成账号登录后，
 * 这些名字照样从 transcript 里扫出来挂在列表上，而选中就报「模型不存在」（实测）。
 */
export function claudeRoute({ env = process.env, settings = '' } = {}) {
  let url = '';
  try {
    url = JSON.parse(String(settings || '{}'))?.env?.ANTHROPIC_BASE_URL ?? '';
  } catch {
    // settings.json 坏了，CLI 自己也不会认它，退回进程环境
  }
  url ||= env.ANTHROPIC_BASE_URL ?? '';
  if (!url) return 'official';
  try {
    return new URL(url).hostname === 'api.anthropic.com' ? 'official' : 'relay';
  } catch {
    return 'relay';
  }
}

/** Anthropic 自己的模型名都以 `claude-` 开头；别名（opus/sonnet/fable）另算。 */
const anthropicName = (id) => id.startsWith('claude-');

/**
 * Claude 侧**拿不到目录时**的兜底候选。
 *
 * `claude --help` 原文：「Provide an alias for the latest model (e.g. 'fable',
 * 'opus', or 'sonnet') or a model's full name」。别名的好处正是**它不会过期**
 * ——出了新一代，`opus` 自动指向新的那个，而写死 `claude-opus-5` 会在某天
 * 变成一个选中即失败的值。
 *
 * 2026-11-10 起它只是兜底：Claude Code 有了自己的模型目录（agent/catalog.js 的
 * claudeCatalog），直连时整张表照目录列，别名一个不放——目录里 `opus` 就指向
 * `claude-opus-5-5`，两个并排就是 owner 说的「明明已经有 opus 和 sonnet 了又有重复的」。
 * 走中转时目录不算数（中转认什么只有它知道），别名还留着，但指向的那个型号已经
 * 在列表里的就不再放。
 */
const CLAUDE_ALIASES = [
  { id: 'opus', desc: '最强的那一档' },
  { id: 'sonnet', desc: '日常够用，快一些' },
  { id: 'fable', desc: '最新一代' },
];

/**
 * owner 在 `/model` 里给每个模型调过、落了盘的思考强度。
 *
 * claude 2.1.322 存在 `~/.claude/settings.json` 的 `modelSettings.<模型>.effortLevel`
 * （这台机器：`claude-opus-5-5 → xhigh`）。CLI 起一轮、没带 `--effort` 时按这个顺序取：
 *
 *   modelSettings 里这个模型那一项  >  顶层 effortLevel  >  目录里的 default_effort
 *
 * 键先归一：去掉 `[1m]`、别名换成它指向的型号；同一个型号有精确键就用精确键
 * （照 CLI 里那段取值逻辑抄的，见 agent-protocol §16）。不读这个，界面上选了 Opus 5.5
 * 会写「默认 · 中」，而真跑起来是「超高」。
 *
 * 只读用户级的这一份：项目级 `.claude/settings.json` 跟着各会话的目录走，
 * 不是「这个模型」的属性。
 *
 * @param {string} json  settings.json 原文
 * @param {Record<string, string>} [aliases]  别名 → 型号（目录给的）
 */
export function claudeEffortPins(json, aliases = {}) {
  let o;
  try {
    o = JSON.parse(String(json || '{}'));
  } catch {
    return { byModel: {}, top: null };
  }
  const canon = (k) => {
    const base = String(k).replace(/\[1m\]$/i, '');
    return aliases[base] ?? base;
  };
  /** @type {Record<string, string>} */
  const byModel = {};
  for (const [k, v] of Object.entries(o?.modelSettings ?? {})) {
    const lvl = v?.effortLevel;
    if (typeof lvl !== 'string') continue;
    const id = canon(k);
    if (k === id || !Object.hasOwn(byModel, id)) byModel[id] = lvl;
  }
  return { byModel, top: typeof o?.effortLevel === 'string' ? o.effortLevel : null };
}

/**
 * Claude 的候选表。
 *
 * **直连、目录在**：照目录列，次序也照目录——`/model` 什么顺序这里就什么顺序。
 *   - 跑过的哪怕在 overflow 里也露出来（跑过的一律不藏，与 Codex 同一条规矩）
 *   - owner 自己在 settings.json 里填的、目录里没有的，补在最后
 *   - transcript 里跑过、目录里却没有的**不列**：目录是这个账号此刻能选的全集，
 *     不在里面的要么已下线，要么是中转时期的别家名字（11-03 那次 k3 的教训）
 *
 * **否则**（走中转，或这台电脑的 Claude Code 还没有目录）：跑过的 + 配置里的 + 别名，
 * 别名指向的型号已经在表里的就不放——那就是重复。
 *
 * 每个模型的 `defaultEffort` 叠上 owner 存过的那档（claudeEffortPins）——那才是
 * 「选了它、没选强度」时真会发出去的。
 *
 * @param {{ route: string, seen: string[], cfg: string[],
 *   cat: ReturnType<typeof claudeCatalog>, merge: Function, settings?: string }} o
 */
function claudeList({ route, seen, cfg, cat, merge, settings = '' }) {
  if (route === 'official' && cat?.models.length) {
    const ran = new Set(seen);
    const pins = claudeEffortPins(settings, cat.aliases);
    // 只认这个模型自己支持的档：存了个它不认的值，CLI 也不会照发
    const fits = (m, e) => (e && m.efforts.includes(e) ? e : null);
    const out = cat.models.filter((m) => ok(m.id)).map((m) => ({
      ...m,
      defaultEffort: fits(m, pins.byModel[m.id]) ?? fits(m, pins.top) ?? m.defaultEffort,
      seen: ran.has(m.id),
      hidden: m.hidden && !ran.has(m.id),
      listed: true,
    }));
    for (const x of merge([], [], cfg)) {
      if (!out.some((y) => y.id === x.id)) out.push({ ...x, seen: ran.has(x.id) });
    }
    return out;
  }
  const base = merge(seen, [], cfg);
  const aliases = CLAUDE_ALIASES.filter((a) => !base.some((x) => x.id === cat?.aliases?.[a.id]));
  return merge(seen, [], cfg, aliases);
}

const ANTIGRAVITY_TIERS = [
  { id: 'pro', name: 'Pro', desc: '深度推理与复杂工程任务主力档位（不带 --effort）' },
  { id: 'flash', name: 'Flash', desc: '响应迅速的日常开发档位（不带 --effort）' },
  { id: 'flash_lite', name: 'Flash Lite', desc: '轻量极速档位（不带 --effort）' },
];

/** 从本机 Antigravity 目录、配置文件与内置档位推导出可选模型列表。 */
export function antigravityModels({ home = os.homedir(), read = safeRead, catalog = null } = {}) {
  const seenIds = [];
  const push = (id) => {
    if (ok(id) && !seenIds.includes(id)) seenIds.push(id);
  };
  for (const file of [
    path.join(home, '.gemini', 'antigravity-cli', 'settings.json'),
    path.join(home, '.gemini', 'settings.json'),
  ]) {
    const raw = read(file);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      push(parsed?.model);
      push(parsed?.defaultModel);
    } catch {
      // 配置损坏，忽略
    }
  }
  const out = [];
  const catModels = Array.isArray(catalog?.models) ? catalog.models : [];
  for (const m of catModels) {
    if (!ok(m?.id) || out.some((x) => x.id === m.id)) continue;
    out.push({
      id: m.id,
      name: m.name || displayName(m.id),
      desc: m.desc ?? null,
      seen: false,
      hidden: !!m.hidden,
      efforts: Array.isArray(m.efforts) ? m.efforts : [],
      defaultEffort: m.defaultEffort ?? null,
      listed: true,
    });
  }
  for (const id of seenIds) {
    if (out.some((x) => x.id === id)) continue;
    out.push({
      id,
      name: displayName(id),
      desc: '本机配置文件指定',
      seen: false,
      hidden: false,
      efforts: [],
      defaultEffort: null,
      listed: false,
    });
  }
  for (const tier of ANTIGRAVITY_TIERS) {
    if (out.some((x) => x.id === tier.id)) continue;
    out.push({
      id: tier.id,
      name: tier.name,
      desc: tier.desc,
      seen: false,
      // 有权威目录时把快捷别名档位收进「更多模型」，避免和具体型号重复
      hidden: catModels.length > 0,
      efforts: [],
      defaultEffort: null,
      listed: true,
    });
  }
  return out;
}

/**
 * 三个 agent 的候选模型。结果带 TTL 缓存——扫盘不算便宜，而模型列表几分钟内不会变。
 *
 * **异步**：Codex 那边要去问 `codex debug models` 拿权威目录。拿不到就退回
 * 纯现推的结果，不会因此失败。
 *
 * 每一项的字段：
 *   id            进 argv 的名字
 *   name          显示名（目录给的，或由 id 推出来）
 *   desc          副标题，可能为 null
 *   seen          transcript 里真跑过。UI 据此区分「验证过的」和「配置里写着
 *                 但没跑过的」，后者选中失败时人知道该怀疑中转而不是 Baton
 *   hidden        长尾，收进「更多模型」
 *   efforts       这个模型支持哪几档思考强度（只有 Codex 目录给得出）
 *   defaultEffort 没选过时实际生效的那一档
 */
export async function discoverModels({
  home = os.homedir(), ttlMs = 5 * 60_000, now = Date.now(), force = false,
  catalog = codexCatalog, claudeCat = claudeCatalog, agCat = cachedAntigravityCatalog, env = process.env,
} = {}) {
  const read = safeRead;

  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const claudeSettings = read(path.join(claudeDir, 'settings.json'));
  // 每次都判：在 settings.json 里切了供应商，不该等缓存过期才反映出来
  const route = claudeRoute({ env, settings: claudeSettings });
  const runtime = await codexRuntime(env);
  const codexDir = runtime.env.CODEX_HOME || path.join(home, '.codex');
  const codexToml = read(path.join(codexDir, 'config.toml')) ?? '';
  const key = JSON.stringify([claudeDir, route, codexDir, runtime.command,
    providerFingerprint(runtime.env, codexToml), fileStamp(path.join(codexDir, 'auth.json'))]);
  const catalogFile = path.join(codexDir, 'models_cache.json');
  if (!force && cache?.key === key && cache.catalogStamp === fileStamp(catalogFile) && now - cache.at < ttlMs) return cache.value;

  // subagents/ 下是子 agent 追踪，不是主会话。
  // 它们的模型可能被强制成小模型，混进来会让人以为主会话也能选。
  const seenClaude = scanRecent(path.join(claudeDir, 'projects'), {
    skip: (p) => p.includes(`${path.sep}subagents${path.sep}`),
  });
  const seenCodex = scanRecent(path.join(codexDir, 'sessions'));

  const cfgClaude = modelsFromClaudeSettings(claudeSettings);
  // 直连 Anthropic 时，中转那边跑过的别家模型选了必失败，不列。走中转时不筛：
  // 中转认什么名字只有它自己知道，「跑过」仍是最硬的证据
  const forRoute = (ids) => (route === 'official' ? ids.filter(anthropicName) : ids);
  const cfgCodex = modelsFromCodexConfig(codexToml);
  const codexPrefs = codexPrefsFromConfig(codexToml);

  let cat = [];
  try {
    if (pendingCatalog?.key !== key || pendingCatalog.catalog !== catalog) {
      const result = Promise.resolve().then(() => catalog({ runtime })).finally(() => {
        if (pendingCatalog?.result === result) pendingCatalog = null;
      });
      pendingCatalog = { key, catalog, result };
    }
    cat = (await pendingCatalog.result).filter((entry) => ok(entry.id));
  } catch {
    cat = []; // 目录是锦上添花，拿不到就当没有
  }
  const byId = new Map(cat.map((m) => [m.id, m]));

  /**
   * 合并的次序就是**可信度**的次序：跑过的 > 目录里的 > 配置里写的 > 别名。
   * 前面的先占位，后面的只补没出现过的 id。
   */
  const merge = (seen, catalogList, cfg, extra = []) => {
    const out = [];
    const put = (id, seenFlag, fallbackDesc = null) => {
      if (!id || out.some((x) => x.id === id)) return;
      const c = byId.get(id);
      out.push({
        id,
        name: c?.name || displayName(id),
        desc: c?.desc ?? fallbackDesc,
        seen: seenFlag,
        // 跑过的一律露出来，哪怕目录把它标成 hide——它在这台机器上确实在用
        hidden: seenFlag ? false : !!c?.hidden,
        efforts: c?.efforts ?? [],
        defaultEffort: c?.defaultEffort ?? null,
        listed: !!c,
      });
    };
    for (const id of seen) put(id, true);
    for (const m of catalogList) put(m.id, false);
    for (const id of cfg) put(id, false);
    for (const e of extra) put(e.id, false, e.desc);
    return out;
  };

  const agCatRes = typeof agCat === 'function' ? agCat() : agCat;
  const agList = antigravityModels({ home, read, catalog: agCatRes });

  const value = {
    claude: claudeList({
      route, seen: forRoute(seenClaude), cfg: forRoute(cfgClaude), cat: claudeCat({ home, configDir: claudeDir }), merge,
      settings: claudeSettings,
    }),
    codex: merge(seenCodex, cat, cfgCodex).map((entry) =>
      cat.length && !entry.listed && !cfgCodex.includes(entry.id) ? { ...entry, hidden: true } : entry),
    antigravity: agList,
    /**
     * 这台电脑上**已经配好**的东西。界面据此说「跟这台电脑的设置走（现在是 X）」
     * 而不是含糊的「默认」——后者等于让人自己去电脑上翻。
     *
     * `defaultModel` = 一个模型都不选时实际跑的那个，连同它默认拿到的强度。
     * 强度放在它身上而不是 `effort`：Claude 的默认强度是**按模型**定的
     * （Opus 5.5 是 medium），换个模型就不一定了；而 Codex 的 `effort` 是配置里
     * 写死的一档，对哪个模型都生效。
     *
     * Claude 这一格在这里是空的，由 listModels 补：Claude 的默认问的是 CLI 自己
     * （agent/defaults.js），配置文件里读不出来，要起一次进程——不该让每个调用
     * discoverModels 的地方都付这个代价。
     */
    config: {
      codex: {
        effort: codexPrefs.effort,
        contextWindow: codexPrefs.contextWindow,
        defaultModel: codexPrefs.model
          ? {
            id: codexPrefs.model,
            name: byId.get(codexPrefs.model)?.name || displayName(codexPrefs.model),
            // 配置里的上下文窗口对哪个模型都生效，界面上另有一行报它，这里不重复
            contextWindow: null,
            effort: codexPrefs.effort,
          }
          : null,
      },
      claude: { effort: null, contextWindow: null, defaultModel: null },
      antigravity: {
        effort: agCatRes?.effort ?? null,
        contextWindow: agCatRes?.contextWindow ?? null,
        defaultModel: agCatRes?.defaultModel ?? null,
      },
    },
  };
  cache = { at: now, key, catalogStamp: fileStamp(catalogFile), value };
  return value;
}

export function clearModelCache() {
  cache = null;
}
