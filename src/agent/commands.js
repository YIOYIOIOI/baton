import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { normPath } from '../scope.js';
import { probeClaudeDefaults } from './defaults.js';
import { killChildTree } from './spawn.js';
import { cliLaunch, spawnCodexAppServer } from './codexRuntime.js';

/**
 * 输入框里打 `/` 弹出来的那张命令表。
 *
 * ## 从哪来（2026-11-10 实测，claude 2.1.322）
 *
 * `claude -p --output-format stream-json` 一启动、还没发任何请求，就先吐一条 `system/init`：
 *
 *   slash_commands            这个目录下**非交互模式能用**的命令，109 个：内置的 36 个
 *                             （goal / compact / context …）+ 技能 + 插件命令。项目里的
 *                             `.claude/commands`、`.claude/skills` 也在内，所以按目录缓存
 *   skills                    其中哪些是技能
 *   terminal_slash_commands   只能在终端界面里用的（doctor / color / focus / reload-plugins）
 *   plugins                   插件名与它在盘上的目录（技能说明要去那里读）
 *
 * 两条来路，都不花钱：
 *   1. 每一轮真跑的时候 init 会经过 Baton（turns.js 的 defaultRunner），顺手记下
 *   2. 记录里没有这个目录时，起一次探针（agent/defaults.js，请求打到本机假端点），
 *      拿到 init 当场收掉——约 4 秒
 *
 * 不维护一张「Claude 有哪些命令」的表——那正是 owner 说的「定死」。下面的 ZH 只是给
 * 认得的命令配一句中文说明，命令有没有、叫什么，以 CLI 报的为准。
 */

const TTL_MS = 30 * 60_000;

/** @type {Map<string, { at: number, init: object }>} 目录 → 最近一次 init */
const seen = new Map();
/** @type {Map<string, Promise<object|null>>} 正在探的目录——同一个目录同时只探一次 */
const probing = new Map();

export const keyOf = (cwd) => normPath(cwd);

/**
 * 内置命令的中文说明；仅覆盖常见斜杠命令，其余按需透传。
 */
const ZH = {
  goal: '定一个目标，达成之前 agent 不会停下',
  compact: '把前面的对话压成摘要，腾出上下文',
  context: '看上下文用了多少、花在哪',
  clear: '清空上下文开新会话（旧会话还在，可以接着用）',
  model: '换这个会话用的模型',
  effort: '调思考强度',
  usage: '看这次会话的花费、套餐额度和活跃情况',
  recap: '用一句话回顾这个会话到哪了',
  rename: '给这个会话改名',
  init: '为这个项目生成 CLAUDE.md',
  'code-review': '审查当前改动，找正确性问题',
  'security-review': '对当前分支的改动做安全审查',
  simplify: '审查改过的代码，把能简化的直接改掉',
  insights: '生成一份分析你 Claude Code 用法的报告',
  advisor: '在关键处请更强的模型出主意',
  autocompact: '设上下文满到多少时自动压缩',
  mcp: '管理 MCP 服务器',
  'output-style': '列出或切换输出风格',
  'skill-doctor': '看哪些技能没用上、白占上下文',
  ultrareview: '在云端起一个会话，找出并核实分支里的 bug',
  batch: '大改动：先调研规划，再分给多个 worktree agent 并行做',
  schedule: '创建、管理定时运行的远程 agent',
  loop: '按间隔反复跑一个提示或命令',
  debug: '打开调试日志，帮忙诊断问题',
  'fewer-permission-prompts': '把常用的只读命令加进白名单，少弹权限确认',
  'update-config': '改 Claude Code 的 settings.json',
  'claude-api': 'Claude API / SDK 参考',
  dataviz: '做图表和数据可视化',
  'deep-research': '多来源深度调研，写成报告',
  run: '启动并操作这个项目的应用，看改动生没生效',
  import: '从别的 AI 编程工具导入配置',
  'auto-mode-setup': '给自动模式讲清楚你的环境',
  'list-agents': '列出能发消息的子 agent 和其他会话',
  'team-onboarding': '按你的用法给队友写一份上手指南',
  'usage-credits': '设置用量额度，或额度用完时向管理员申请',
  design: '按简报做一个新的设计稿',
  config: '打开设置',
};

/** 排在最前面的几个——最常用、在手机上最有用的 */
const FIRST = ['goal', 'compact', 'context', 'code-review', 'security-review', 'simplify', 'init', 'recap', 'usage', 'clear'];

/**
 * 不列的：内部/已移除的命令（`__` 开头、workflow-launch-exec、design-consent/revoke、agents、extra-usage）。
 */
const HIDDEN = new Set(['workflow-launch-exec', 'design-consent', 'design-revoke', 'agents', 'extra-usage']);

/** 读 SKILL.md / 命令 .md 的 frontmatter 里那句 description。读不到返回 null。 */
export function descriptionOf(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''));
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith('description:'));
  if (i < 0) return null;
  let v = lines[i].replace(/^description:\s*/, '').trim();
  if (v === '|' || v === '>' || v === '|-' || v === '>-' || v === '') {
    const more = [];
    for (let j = i + 1; j < lines.length && /^\s+/.test(lines[j]); j += 1) more.push(lines[j].trim());
    v = more.join(' ');
  }
  v = v.replace(/^["']|["']$/g, '').trim();
  return v || null;
}

function readDesc(files) {
  for (const f of files) {
    try {
      const d = descriptionOf(fs.readFileSync(f, 'utf8'));
      if (d) return d;
    } catch {
      // 这个位置没有，看下一个
    }
  }
  return null;
}

/**
 * init → 菜单项。
 *
 * @param {any} init  `system/init` 那条记录
 * @param {{ cwd?: string, home?: string }} [opts]
 * @returns {Array<{ name: string, desc: string|null, group: 'builtin'|'skill'|'plugin', common: boolean, inline: boolean }>}
 */
export function commandsFromInit(init, { cwd = init?.cwd ?? '', home = os.homedir() } = {}) {
  const all = Array.isArray(init?.slash_commands) ? init.slash_commands.filter((x) => typeof x === 'string') : [];
  const skills = new Set(Array.isArray(init?.skills) ? init.skills : []);
  const terminal = new Set(Array.isArray(init?.terminal_slash_commands) ? init.terminal_slash_commands : []);
  const plugins = new Map((Array.isArray(init?.plugins) ? init.plugins : [])
    .filter((p) => p?.name && p?.path && p.path !== 'builtin').map((p) => [p.name, p.path]));

  const out = [];
  for (const name of new Set(all)) {
    if (terminal.has(name) || name.startsWith('__') || HIDDEN.has(name)) continue;
    const colon = name.indexOf(':');
    /** @type {'builtin'|'skill'|'plugin'} */
    let group;
    /** @type {string|null} */
    let desc;
    if (colon > 0) {
      group = 'plugin';
      const dir = plugins.get(name.slice(0, colon));
      const sub = name.slice(colon + 1);
      desc = dir ? readDesc([path.join(dir, 'skills', sub, 'SKILL.md'), path.join(dir, 'commands', `${sub}.md`)]) : null;
    } else if (skills.has(name)) {
      group = 'skill';
      desc = ZH[name] ?? readDesc([
        path.join(cwd, '.claude', 'skills', name, 'SKILL.md'),
        path.join(home, '.claude', 'skills', name, 'SKILL.md'),
      ]);
    } else {
      group = 'builtin';
      desc = ZH[name] ?? readDesc([
        path.join(cwd, '.claude', 'commands', `${name}.md`),
        path.join(home, '.claude', 'commands', `${name}.md`),
      ]);
    }
    out.push({
      name,
      desc: desc ? desc.slice(0, 240) : null,
      group,
      // 菜单里放在「常用」底下（FIRST 里那几个，跨内置和技能）
      common: FIRST.includes(name),
      // 能不能写在句子中间。内置命令只在整条消息开头才执行（/compact 写在句中什么也不会发生）；
      // 技能和插件命令写在句中是一次「点名」，见 agent-protocol §19
      inline: group !== 'builtin',
    });
  }
  const rank = (c) => {
    const f = FIRST.indexOf(c.name);
    if (f >= 0) return f;
    return 100 + ['builtin', 'skill', 'plugin'].indexOf(c.group) * 1000;
  };
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** 真跑的那一轮经过的 init，记下来。turns.js 的 defaultRunner 调 */
export function rememberInit(cwd, init, { now = Date.now() } = {}) {
  if (!cwd || !Array.isArray(init?.slash_commands)) return;
  seen.set(keyOf(cwd), { at: now, init });
}

/**
 * 这个目录下能用的命令。
 *
 * `probe` 为假时只看记录（不起进程）：界面先拿这个当场画，记录里没有或过期了再带 probe 来一次。
 *
 * @param {{ cwd: string, probe?: boolean, now?: number, ttlMs?: number,
 *   run?: (cwd: string) => Promise<object|null> }} opts
 * @returns {Promise<{ commands: ReturnType<typeof commandsFromInit>, at: number|null, stale: boolean }>}
 */
export async function claudeCommands({
  cwd, probe = false, now = Date.now(), ttlMs = TTL_MS, run = probeInit,
}) {
  const k = keyOf(cwd);
  let hit = seen.get(k) ?? null;
  const fresh = hit && now - hit.at < ttlMs;
  if (!fresh && probe) {
    let p = probing.get(k);
    if (!p) {
      p = run(cwd).finally(() => probing.delete(k));
      probing.set(k, p);
    }
    const init = await p.catch(() => null);
    if (init) {
      rememberInit(cwd, init, { now });
      hit = seen.get(k) ?? null;
    }
  }
  return {
    commands: hit ? commandsFromInit(hit.init, { cwd }) : [],
    at: hit?.at ?? null,
    stale: !hit || now - hit.at >= ttlMs,
  };
}

/** 起一次探针，只要 init。拿不到返回 null */
function probeInit(cwd) {
  let got = null;
  return probeClaudeDefaults({
    cwd, timeoutMs: 30_000, stopAtInit: true, onInit: (r) => { got = r; },
  }).then(() => got);
}

/* ── Codex ──────────────────────────────────────────────────────────────── */

/**
 * Codex 会话的技能表（2026-11-11）。
 *
 * owner：「codex 的适配去哪了？/ 命令呢？」。Codex 没有 init 那种「这个目录能用什么」的现成输出，
 * 但它的 app-server 有 `skills/list`（`{ cwds }` → 每个目录一组 `{ name, description, enabled,
 * interface.shortDescription, path }`）。本机实测这个目录下 61 个，有几个同名不同路径的。
 *
 * **插入的是 `$名字` 不是 `/名字`**——实测 `codex exec` 收到文字里的 `$my-skill` 会把整份
 * SKILL.md 当一条 `<skill>` 注入这一轮，`/my-skill` 不会（agent-protocol §19）。Codex 的
 * `/compact` 这类内置命令只在它自己的界面里，exec 不认，所以表里只有技能。
 */
/** @type {Map<string, { at: number, skills: Array<object> }>} */
const codexSeen = new Map();
/** @type {Map<string, Promise<Array<object>|null>>} */
const codexProbing = new Map();

/** `skills/list` 的一组 → 菜单项。同名的只留第一个启用着的 */
export function codexSkillsFrom(skills) {
  const out = [];
  const names = new Set();
  for (const s of Array.isArray(skills) ? skills : []) {
    const name = s?.name;
    if (typeof name !== 'string' || !name || s.enabled === false || names.has(name)) continue;
    names.add(name);
    const desc = s.interface?.shortDescription || s.description || null;
    out.push({
      name,
      desc: typeof desc === 'string' ? desc.slice(0, 240) : null,
      group: name.includes(':') ? 'plugin' : 'skill',
      common: false,
      inline: true,
    });
  }
  return out.sort((a, b) => (a.group === b.group ? a.name.localeCompare(b.name) : a.group === 'skill' ? -1 : 1));
}

/** 和 claudeCommands 同一套：不带 probe 只看记录，带了才去问 codex（起一次 app-server，一两秒） */
export async function codexCommands({
  cwd, probe = false, now = Date.now(), ttlMs = TTL_MS, run = listCodexSkills,
}) {
  const k = keyOf(cwd);
  let hit = codexSeen.get(k) ?? null;
  if (!(hit && now - hit.at < ttlMs) && probe) {
    let p = codexProbing.get(k);
    if (!p) {
      p = run(cwd).finally(() => codexProbing.delete(k));
      codexProbing.set(k, p);
    }
    const skills = await p.catch(() => null);
    if (skills) {
      hit = { at: now, skills };
      codexSeen.set(k, hit);
    }
  }
  return {
    commands: hit ? codexSkillsFrom(hit.skills) : [],
    at: hit?.at ?? null,
    stale: !hit || now - hit.at >= ttlMs,
  };
}

/**
 * 起一个 `codex app-server` 问 `skills/list`。和 codexQueue.js 同一套启动与收尾
 * （Windows 上 codex 是 .cmd，经 shell；收的时候 taskkill /t 连同 codex 本身）。
 */
export async function listCodexSkills(cwd, {
  command = 'codex', timeoutMs = 30_000, spawnFn = spawn, killTreeFn = null,
} = {}) {
  if (spawnFn === spawn && process.env.BATON_NO_CLI_PROBES === '1') {
    return [];
  }
  const launch = await cliLaunch(command);
  return new Promise((resolve, reject) => {
    const child = spawnCodexAppServer(launch, spawnFn);
    let buf = '';
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin?.end?.();
      } catch {
        // ignore
      }
      try {
        if (killTreeFn) killTreeFn(child.pid, child);
        else killChildTree(child);
      } catch {
        // 已经退了
      }
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('codex 没在时限内回话')), timeoutMs);
    timer.unref?.();
    child.stdin?.on?.('error', (e) => finish(e));
    const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
    child.on('error', (e) => finish(e));
    child.on('exit', (code) => finish(new Error(`codex app-server 提前退出了（${code}）`)));
    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      if (buf.length > 8 * 1024 * 1024) {
        finish(new Error('codex app-server 输出超过上限'));
        return;
      }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'skills/list', params: { cwds: [cwd] } });
        } else if (m.id === 2) {
          if (m.error) finish(new Error(m.error.message ?? 'skills/list 失败'));
          else finish(null, (m.result?.data ?? [])[0]?.skills ?? []);
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'baton', version: '1' }, capabilities: {} } });
  });
}

/* ── Antigravity ────────────────────────────────────────────────────────── */

const AG_BUILTIN_COMMANDS = [
  { name: 'goal', desc: '设定长期目标，达成并输出完成标记前持续推进', group: 'builtin', common: true, inline: true },
  { name: 'plan', desc: '复杂任务先进入分步规划，确认后再执行', group: 'builtin', common: true, inline: false },
  { name: 'compact', desc: '压缩当前对话上下文并保留关键进展', group: 'builtin', common: true, inline: false },
  { name: 'schedule', desc: '创建定时自动化或一次性延迟提醒', group: 'builtin', common: true, inline: false },
  { name: 'browser', desc: '启用内置浏览器执行网页浏览与交互操作', group: 'builtin', common: true, inline: true },
  { name: 'grill-me', desc: '通过多轮提问严格对齐设计方案与关键决策', group: 'builtin', common: false, inline: false },
  { name: 'teamwork', desc: '多代理协同分工处理大型并行任务', group: 'builtin', common: false, inline: false },
  { name: 'learn', desc: '沉淀纠偏与环境经验供后续任务持久复用', group: 'builtin', common: false, inline: false },
  { name: 'boost', desc: '开启深度思考、多视角核验与严格验证模式', group: 'builtin', common: true, inline: true },
];

function parseSkillMeta(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''));
  if (!m) return { name: null, desc: null, disabledSlash: false };
  const fm = m[1];
  const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, '') || null;
  const disabledSlash = /^disable-slash-command:\s*true\b/mi.test(fm);
  return { name, desc: descriptionOf(text), disabledSlash };
}

function scanSkillDir(skillsDir, group) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillFile = path.join(skillsDir, e.name, 'SKILL.md');
    let text;
    try {
      text = fs.readFileSync(skillFile, 'utf8');
    } catch {
      continue;
    }
    const meta = parseSkillMeta(text);
    if (meta.disabledSlash) continue;
    const name = meta.name || e.name;
    out.push({
      name,
      desc: meta.desc ? meta.desc.slice(0, 240) : null,
      group,
      common: false,
      inline: true,
    });
  }
  return out;
}

/**
 * Antigravity 的斜杠命令与技能列表：直读项目 `.agents/skills` 与全局 `~/.gemini/` 技能目录，
 * 无需起任何子进程，零延迟。
 */
export async function antigravityCommands({ cwd = '', home = os.homedir(), now = Date.now() } = {}) {
  const merged = new Map();
  const add = (c) => {
    if (!c?.name || merged.has(c.name)) return;
    merged.set(c.name, c);
  };
  for (const b of AG_BUILTIN_COMMANDS) add(b);

  if (cwd) addEach(scanSkillDir(path.join(cwd, '.agents', 'skills'), 'skill'));
  addEach(scanSkillDir(path.join(home, '.gemini', 'config', 'skills'), 'skill'));

  const pluginsDir = path.join(home, '.gemini', 'config', 'plugins');
  try {
    for (const p of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
      if (p.isDirectory()) addEach(scanSkillDir(path.join(pluginsDir, p.name, 'skills'), 'plugin'));
    }
  } catch {
    // 没装外部插件
  }

  for (const appDir of ['antigravity', 'antigravity-cli', 'antigravity-ide']) {
    addEach(scanSkillDir(path.join(home, '.gemini', appDir, 'builtin', 'skills'), 'builtin'));
  }

  function addEach(list) {
    for (const item of list) add(item);
  }

  const order = { builtin: 0, skill: 1, plugin: 2 };
  const commands = [...merged.values()].sort((a, b) => (
    (a.common === b.common ? 0 : (a.common ? -1 : 1))
    || order[a.group] - order[b.group]
    || a.name.localeCompare(b.name)
  ));
  return { commands, at: now, stale: false };
}

/** 测试用 */
export function clearCommandCache() {
  seen.clear();
  probing.clear();
  codexSeen.clear();
  codexProbing.clear();
}
