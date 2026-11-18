import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildClaudeArgs, buildCodexArgs, buildClaudeNewArgs, buildCodexNewArgs, assertModel,
} from '../src/agent/args.js';
import {
  modelsFromCodexConfig, modelsFromClaudeSettings, modelsFromTranscript,
  scanRecent, discoverModels, clearModelCache, codexPrefsFromConfig, claudeRoute,
} from '../src/models.js';
import { getModel, setModel, allModels, reconcilePrefs } from '../src/runtime/prefs.js';

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
/** 换行符。写成常量是为了让生成这段代码的脚本不必转义它——踩过两次。 */
const NL = String.fromCharCode(10);

// ── 模型名校验 ──────────────────────────────────
//
// 这一组是安全边界，不是格式洁癖：Windows 上 claude/codex 是 .cmd，必须经 shell
// 启动，而 Node 的 DEP0190 明说传给 shell 的参数「不转义、只拼接」。
// 模型名是这条链上唯一由用户直接提供、又必须进 argv 的值。

test('模型名：shell 元字符一律拒绝', () => {
  const bad = [
    'a b', 'a;rm -rf /', '`id`', '$(id)', 'a&b', 'a|b', 'a>f', 'a<f',
    'a"b', "a'b", 'a\nb', 'a\tb', '%PATH%', 'a^b', 'a(b)', '..\\x',
  ];
  for (const v of bad) {
    assert.throws(() => assertModel(v), /模型名/, `本该拒绝：${JSON.stringify(v)}`);
  }
});

test('模型名：这台机器上真实存在的名字必须放行', () => {
  // 全是实测扫出来的，不是编的。任何一个被拒 = 这个功能在这台机器上直接不可用。
  for (const v of ['claude-opus-5', 'claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5',
    'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'opus', 'sonnet', 'o3', 'gpt-5-codex']) {
    assert.equal(assertModel(v), v, `本该放行：${v}`);
  }
});

test('模型名：空值 = 不传 --model，不是错误', () => {
  for (const v of [undefined, null, '']) assert.equal(assertModel(v), null);
  assert.ok(!buildClaudeArgs({ sessionId: ID }).includes('--model'));
  assert.ok(!buildCodexArgs({ threadId: ID }).includes('--model'));
  assert.ok(!buildClaudeNewArgs({ sessionId: ID }).includes('--model'));
  assert.ok(!buildCodexNewArgs().includes('--model'));
});

test('模型名：超长拒绝（64 是上限，不是建议）', () => {
  assert.equal(assertModel('x'.repeat(64)), 'x'.repeat(64));
  assert.throws(() => assertModel('x'.repeat(65)), /模型名/);
});

test('四个 arg builder 都把 --model 接上，且值原样传递', () => {
  const cases = [
    ['claude resume', buildClaudeArgs({ sessionId: ID, model: 'claude-opus-5' }), 'claude-opus-5'],
    ['claude new', buildClaudeNewArgs({ sessionId: ID, model: 'claude-sonnet-5' }), 'claude-sonnet-5'],
    ['codex resume', buildCodexArgs({ threadId: ID, model: 'gpt-6-astra' }), 'gpt-6-astra'],
    ['codex new', buildCodexNewArgs({ model: 'gpt-5.6-sol' }), 'gpt-5.6-sol'],
  ];
  for (const [label, args, want] of cases) {
    const i = args.indexOf('--model');
    assert.ok(i >= 0, `${label} 没接上 --model`);
    assert.equal(args[i + 1], want, `${label} 的值不对`);
  }
});

test('fork 与 model 能同时出现', () => {
  const a = buildClaudeArgs({ sessionId: ID, fork: true, model: 'claude-opus-5' });
  assert.ok(a.includes('--fork-session') && a.includes('--model'));
});

// ── 列表现推 ────────────────────────────────────

test('codex config.toml：只取 model / review_model，不误取 model_provider', () => {
  const toml = [
    'model_provider = "custom"',
    'model = "gpt-6-astra"',
    'model_reasoning_effort = "xhigh"',
    'review_model = "gpt-5.6-sol"',
    'model_context_window = 1000000',
    '[model_providers.custom]',
    'base_url = "https://example.invalid/v1"',
  ].join('\n');
  assert.deepEqual(modelsFromCodexConfig(toml), ['gpt-6-astra', 'gpt-5.6-sol']);
});

test('claude settings.json：取自定义模型项', () => {
  const json = JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: 'https://example.invalid/api/',
      ANTHROPIC_CUSTOM_MODEL_OPTION: 'claude-sonnet-5',
    },
  });
  assert.deepEqual(modelsFromClaudeSettings(json), ['claude-sonnet-5']);
  assert.deepEqual(modelsFromClaudeSettings('{坏 json'), []);
});

test('transcript 挖模型：<synthetic> 和 codex-auto-review 必须排除', () => {
  // 这两个在真实数据里就有（扫 60 个文件时 <synthetic> 出现 76 次）。
  // 混进下拉框 = 用户选中一个必然失败的值。
  const lines = [
    JSON.stringify({ message: { model: 'claude-opus-5' } }),
    JSON.stringify({ message: { model: '<synthetic>' } }),
    JSON.stringify({ payload: { model: 'codex-auto-review' } }),
    JSON.stringify({ payload: { model: 'gpt-5.6-sol' } }),
    '{坏行}',
  ].join('\n');
  assert.deepEqual(modelsFromTranscript(lines).sort(), ['claude-opus-5', 'gpt-5.6-sol']);
});

test('transcript 挖模型：limit 之后就不看了', () => {
  // 单个 transcript 里同一个名字能出现三万多次，全扫是纯浪费
  const lines = [
    ...Array.from({ length: 50 }, () => JSON.stringify({ message: { model: 'a-1' } })),
    JSON.stringify({ message: { model: 'b-2' } }),
  ].join('\n');
  assert.deepEqual(modelsFromTranscript(lines, { limit: 10 }), ['a-1']);
});

test('scanRecent：按 mtime 取最新的几个，subagents 可跳过', () => {
  const dir = tmpDir('baton-models-');
  const sub = path.join(dir, 'subagents');
  fs.mkdirSync(sub, { recursive: true });

  const write = (p, model, mtime) => {
    fs.writeFileSync(p, JSON.stringify({ message: { model } }));
    fs.utimesSync(p, mtime / 1000, mtime / 1000);
  };
  // 三个 mtime 必须互不相同：相同时排序无从分先后，断言就成了掷硬币
  const t0 = Date.now();
  write(path.join(dir, 'old.jsonl'), 'old-model', t0 - 900_000);
  write(path.join(sub, 'agent.jsonl'), 'subagent-model', t0 - 300_000);
  write(path.join(dir, 'new.jsonl'), 'new-model', t0);

  const all = scanRecent(dir, { max: 10 });
  assert.ok(all.includes('subagent-model'), '不跳过时该扫到');

  const skipped = scanRecent(dir, { max: 10, skip: (p) => p.includes(`${path.sep}subagents${path.sep}`) });
  assert.ok(!skipped.includes('subagent-model'), 'subagents 下的不是会话，不该出现在列表里');
  assert.ok(skipped.includes('new-model') && skipped.includes('old-model'));

  assert.deepEqual(scanRecent(dir, { max: 1 }), ['new-model'], 'max=1 只该扫最新那个');
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * 目录一律注入，**绝不真的 spawn `codex debug models`**。
 *
 * 真跑的话这套测试就依赖「这台机器上装了 codex、而且它的目录长成某个样子」——
 * 那不是单测，是环境检查，而且换台机器就红。
 */
const NO_CATALOG = async () => [];
const FAKE_CATALOG = async () => [
  {
    id: 'gpt-6-astra',
    name: 'GPT-6-Astra',
    desc: '最能干的那个',
    hidden: false,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultEffort: 'low',
  },
  {
    id: 'gpt-daybreak-red-latest',
    name: 'Daybreak Red',
    desc: null,
    hidden: true,
    efforts: ['low', 'medium'],
    defaultEffort: 'medium',
  },
];

test('discoverModels：跑过的标 seen，只在配置里的不标', async () => {
  const home = tmpDir('baton-home-');
  fs.mkdirSync(path.join(home, '.claude', 'projects', 'p'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex', 'sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'projects', 'p', 's.jsonl'),
    JSON.stringify({ message: { model: 'claude-opus-5' } }),
  );
  fs.writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ env: { ANTHROPIC_CUSTOM_MODEL_OPTION: 'claude-sonnet-5' } }),
  );
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-6-astra"\n');

  clearModelCache();
  const m = await discoverModels({ home, force: true, catalog: NO_CATALOG });

  assert.deepEqual(m.claude.map((x) => [x.id, x.seen]), [
    ['claude-opus-5', true],
    ['claude-sonnet-5', false],
    // 别名兜底：CLI 文档保证的三个入口，且它们不会随代际过期
    ['opus', false], ['sonnet', false], ['fable', false],
  ]);
  assert.deepEqual(m.codex.map((x) => [x.id, x.seen]), [['gpt-6-astra', false]]);

  // 显示名是**推**出来的，不是查表——查表就又「定死」了
  assert.equal(m.claude[0].name, 'Opus 5');
  assert.equal(m.codex[0].name, '6 Astra');

  clearModelCache();
  fs.rmSync(home, { recursive: true, force: true });
});

test('claudeRoute：没设 base_url 是直连，settings.json 的优先于进程环境', () => {
  assert.equal(claudeRoute({ env: {} }), 'official');
  assert.equal(claudeRoute({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } }), 'official');
  assert.equal(claudeRoute({ env: { ANTHROPIC_BASE_URL: 'https://relay.example' } }), 'relay');
  assert.equal(claudeRoute({
    env: {}, settings: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://relay.example' } }),
  }), 'relay', 'CLI 会拿 settings.json 的 env 盖掉进程环境');
  assert.equal(claudeRoute({ env: {}, settings: '{坏的' }), 'official');
});

/**
 * 2026-11-03 的事：换成账号登录后，中转时期跑过的 k3 / kimi-k3.1-pro 还挂在列表上，
 * 选中就报「模型不存在」。
 */
test('discoverModels：直连时不列中转那边跑过的别家模型，走中转时照列', async () => {
  const home = tmpDir('baton-home-');
  fs.mkdirSync(path.join(home, '.claude', 'projects', 'p'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'projects', 'p', 's.jsonl'),
    ['claude-opus-5-5', 'k3', 'kimi-k3.1-pro'].map((model) => JSON.stringify({ message: { model } })).join('\n'),
  );

  clearModelCache();
  const official = await discoverModels({ home, force: true, catalog: NO_CATALOG, env: {} });
  assert.deepEqual(official.claude.map((x) => x.id), ['claude-opus-5-5', 'opus', 'sonnet', 'fable']);

  // 不 force：路线变了就不该吃上一条路线的缓存
  const relay = await discoverModels({
    home, catalog: NO_CATALOG, env: { ANTHROPIC_BASE_URL: 'https://relay.example' },
  });
  assert.deepEqual(relay.claude.map((x) => x.id),
    ['claude-opus-5-5', 'k3', 'kimi-k3.1-pro', 'opus', 'sonnet', 'fable']);

  clearModelCache();
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * 目录能拿到时，它才是权威：显示名、副标题、长尾、以及**逐模型的思考强度**
 * 都从它来。这正是 owner 说的「选择现有配置里面的可选模型」。
 */
test('discoverModels：目录里的模型带上显示名、长尾标记与可选强度', async () => {
  const home = tmpDir('baton-home-');
  clearModelCache();
  const m = await discoverModels({ home, force: true, catalog: FAKE_CATALOG });

  const astra = m.codex.find((x) => x.id === 'gpt-6-astra');
  assert.equal(astra.name, 'GPT-6-Astra', '目录给了显示名就用它的，不用推的');
  assert.equal(astra.desc, '最能干的那个');
  assert.equal(astra.hidden, false);
  assert.deepEqual(astra.efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(astra.defaultEffort, 'low');

  const red = m.codex.find((x) => x.id === 'gpt-daybreak-red-latest');
  assert.equal(red.hidden, true, 'visibility=hide 的收进「更多模型」');

  clearModelCache();
  fs.rmSync(home, { recursive: true, force: true });
});

/** 跑过的模型一律露出来——哪怕目录把它标成 hide，它在这台机器上确实在用。 */
test('discoverModels：跑过的不会被目录的 hide 藏起来', async () => {
  const home = tmpDir('baton-home-');
  fs.mkdirSync(path.join(home, '.codex', 'sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.codex', 'sessions', 's.jsonl'),
    JSON.stringify({ payload: { model: 'gpt-daybreak-red-latest' } }),
  );
  clearModelCache();
  const m = await discoverModels({ home, force: true, catalog: FAKE_CATALOG });
  const red = m.codex.find((x) => x.id === 'gpt-daybreak-red-latest');
  assert.equal(red.seen, true);
  assert.equal(red.hidden, false);
  clearModelCache();
  fs.rmSync(home, { recursive: true, force: true });
});

/** 目录拿不到（没装 codex、超时、输出不是 JSON）不该让整件事失败。 */
test('discoverModels：目录拿不到时退回现推，不抛', async () => {
  const home = tmpDir('baton-home-');
  clearModelCache();
  const m = await discoverModels({
    home, force: true, catalog: async () => { throw new Error('codex 没装'); },
  });
  assert.deepEqual(m.codex, []);
  assert.deepEqual(m.claude.map((x) => x.id), ['opus', 'sonnet', 'fable']);
  clearModelCache();
  fs.rmSync(home, { recursive: true, force: true });
});

test('discoverModels：目录不存在不抛，只剩别名兜底', async () => {
  clearModelCache();
  const m = await discoverModels({
    home: path.join(os.tmpdir(), 'baton-nope-does-not-exist'), force: true, catalog: NO_CATALOG,
  });
  assert.deepEqual(m.codex, []);
  assert.deepEqual(m.claude.map((x) => x.id), ['opus', 'sonnet', 'fable']);
  clearModelCache();
});

// ── 偏好落盘 ────────────────────────────────────

test('prefs：写了能读回来，清了就没了', () => {
  const dir = tmpDir('baton-prefs-');
  assert.equal(getModel('k1', { dir }), null, '没选过该是 null，不是某个猜测值');

  setModel('k1', 'claude-opus-5', { dir });
  setModel('k2', 'gpt-6-astra', { dir });
  assert.equal(getModel('k1', { dir }), 'claude-opus-5');
  assert.deepEqual(allModels({ dir }), { k1: 'claude-opus-5', k2: 'gpt-6-astra' });

  // 换个「进程」重读：落盘的意义就在这里，重启后选择不能丢
  assert.equal(getModel('k1', { dir }), 'claude-opus-5');

  setModel('k1', null, { dir });
  assert.equal(getModel('k1', { dir }), null);
  assert.deepEqual(allModels({ dir }), { k2: 'gpt-6-astra' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('prefs：会话没了就把它的偏好清掉', () => {
  // 与 queue 的 reconcileQueues、intents 的 reconcileOrphans 同一条纪律。
  // 不清的话这个文件只增不减，而它**每次发消息都要读一遍**。
  const dir = tmpDir('baton-recon-');
  setModel('alive', 'claude-opus-5', { dir });
  setModel('gone', 'gpt-6-astra', { dir });

  const repo = { getSession: (k) => (k === 'alive' ? { key: k } : null) };
  assert.deepEqual(reconcilePrefs({ repo, dir }), ['gone']);
  assert.deepEqual(allModels({ dir }), { alive: 'claude-opus-5' });

  // 再跑一次没得清，也不该报错或重写文件
  assert.deepEqual(reconcilePrefs({ repo, dir }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('prefs：文件坏了当空处理，不抛', () => {
  const dir = tmpDir('baton-prefs-bad-');
  fs.writeFileSync(path.join(dir, 'prefs.json'), '{这不是 json');
  assert.equal(getModel('k', { dir }), null);
  setModel('k', 'claude-opus-5', { dir }); // 还能写回去
  assert.equal(getModel('k', { dir }), 'claude-opus-5');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 目录解析与显示名 ────────────────────────────

/**
 * 这两个函数是这轮的核心：owner 的「模型为什么是定死的」和「codex 为什么没有
 * 思考强度」，答案都在 `codex debug models` 这份目录里。
 */
test('parseCatalog：只取要的字段，剔掉 500KB 的提示词正文', async () => {
  const { parseCatalog } = await import('../src/agent/catalog.js');
  const raw = JSON.stringify({
    models: [
      {
        slug: 'gpt-6-astra',
        display_name: 'GPT-6-Astra',
        description: '最能干的那个',
        visibility: 'list',
        default_reasoning_level: 'low',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }],
        // 真实输出里这一项是几十 KB 的提示词，占了整份 505KB 的绝大部分
        model_messages: { persistent_instructions: 'x'.repeat(5000) },
      },
      { slug: 'gpt-5.4', visibility: 'hide', supported_reasoning_levels: [{ effort: 'high' }] },
      { slug: '', display_name: '没有 slug 的不要' },
      { display_name: '连 slug 字段都没有' },
    ],
  });
  const got = parseCatalog(raw);
  assert.equal(got.length, 2, '没有 slug 的两条要丢掉——它们进不了 argv');
  assert.deepEqual(got[0], {
    id: 'gpt-6-astra',
    name: 'GPT-6-Astra',
    desc: '最能干的那个',
    hidden: false,
    efforts: ['low', 'ultra'],
    defaultEffort: 'low',
  });
  assert.equal(got[1].hidden, true);
  assert.equal(JSON.stringify(got).includes('persistent_instructions'), false, '提示词正文不该留在结果里');
});

test('parseCatalog：坏输入返回空表，不抛', async () => {
  const { parseCatalog } = await import('../src/agent/catalog.js');
  for (const bad of ['', '不是 json', '{}', '{"models":null}', null, undefined, '[]']) {
    assert.deepEqual(parseCatalog(bad), [], String(bad));
  }
});

/**
 * 显示名是**推**出来的不是查表的——查表就又「定死」了，出一个新模型就少一个。
 * 期望值取自 owner 发的两张截图里两个 App 实际显示的字样。
 */
test('displayName：从 id 推出人看的名字', async () => {
  const { displayName } = await import('../src/agent/catalog.js');
  const cases = [
    ['claude-opus-5', 'Opus 5'],
    ['claude-fable-5-1', 'Fable 5.1'],
    ['claude-sonnet-4-5-20250929', 'Sonnet 4.5'],   // 日期戳对人没有意义
    ['gpt-6-astra', '6 Astra'],
    ['gpt-5.6-sol', '5.6 Sol'],
    ['gpt-5.5', '5.5'],
    ['opus', 'Opus'],
    ['o3', 'O3'],
  ];
  for (const [id, want] of cases) assert.equal(displayName(id), want, id);
  // 推不出来时**退回原名**，绝不返回空——空字符串会让那一行在列表里变成一片空白
  for (const bad of ['', null, undefined]) assert.equal(displayName(bad), '');
  assert.equal(displayName('---'), '---');
});

// ── 读用户自己的配置 ────────────────────────────

/**
 * owner 划的产品边界：
 *
 *   我们产品是直接复用用户的配置，用户自己模型有问题和我们的产品没关系，
 *   我们只要保证正确读取用户的模型配置、思考强度、上下文窗口这些就可以了
 *
 * 所以这一组测的**只有一件事：读得对不对**。不校验用户配得合不合理。
 */
test('读 codex 配置里的思考强度与上下文窗口', () => {
  // 取自这台机器上真实的中转配置
  const real = [
    'model_provider = "custom"',
    'model = "gpt-6-astra"',
    'model_reasoning_effort = "xhigh"',
    'review_model = "gpt-5.6-sol"',
    'model_context_window = 1000000',
    '[model_providers.custom]',
  ].join(NL);
  assert.deepEqual(codexPrefsFromConfig(real), { model: 'gpt-6-astra', effort: 'xhigh', contextWindow: 1000000 });
});

test('没配就是 null，不猜一个值填上', () => {
  // 「没配置」和「配了正好等于默认」在界面上要显示得不一样：
  // 前者说「跟默认走」，后者要把那个值报出来
  for (const empty of ['', null, undefined, `[mcp_servers]${NL}foo = 1`]) {
    assert.deepEqual(codexPrefsFromConfig(empty), { model: null, effort: null, contextWindow: null });
  }
});

test('配了个非法强度，如实当成没配', () => {
  // 报一个 agent 不认识的档位比不报更糟——人会以为它生效了
  const r = codexPrefsFromConfig(`model_reasoning_effort = "bogus"${NL}model_context_window = 32000`);
  assert.equal(r.effort, null);
  assert.equal(r.contextWindow, 32000, '强度非法不该连带丢掉上下文窗口');
});

test('不去读第三方配置切换器的数据库', () => {
  // codex 运行时只认 config.toml。读外部数据库等于告诉用户一件不会发生的事，
  // 而且外部数据库里可能存着 API 密钥，能不碰就不碰
  const src = fs.readFileSync(new URL('../src/models.js', import.meta.url), 'utf8')
    // 注释里写着为什么不读它，那不算「碰」。只看代码
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const forbidden = new RegExp(['cc', 'switch'].join('-') + '|node:sqlite');
  assert.ok(!forbidden.test(src), 'models.js 不该碰外部数据库');
});

test('codexPrefsFromConfig：只读顶层，不把某张表里的同名键当成默认', () => {
  // TOML 的顶层键必须写在第一张表之前。[profiles.x] 里的 model 只在选了那个
  // profile 时才生效，不能被当成「这台电脑的默认模型」报出去
  const toml = [
    'model = "gpt-6.1-sol"',
    'model_reasoning_effort = "low"',
    '[profiles.fast]',
    'model = "gpt-5.6-luna"',
    'model_reasoning_effort = "high"',
    'model_context_window = 32000',
  ].join(NL);
  assert.deepEqual(codexPrefsFromConfig(toml), { model: 'gpt-6.1-sol', effort: 'low', contextWindow: null });
  // 顶层没写 model、表里写了：如实报「没配」
  assert.equal(codexPrefsFromConfig(`[profiles.fast]${NL}model = "gpt-5.6-luna"`).model, null);
});

test('discoverModels：Codex 的默认模型取 config.toml 顶层的 model，显示名跟列表一致', async () => {
  const home = tmpDir('baton-home-');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'),
    ['model = "gpt-6-astra"', 'model_reasoning_effort = "low"'].join(NL));
  clearModelCache();
  const m = await discoverModels({ home, force: true, catalog: FAKE_CATALOG });
  assert.deepEqual(m.config.codex.defaultModel, {
    id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: null, effort: 'low',
  });
  // Claude 的默认问的是 CLI 自己，由 listModels 补上；这里不起进程
  assert.equal(m.config.claude.defaultModel, null);
  clearModelCache();
  fs.rmSync(home, { recursive: true, force: true });
});

// ── 整台电脑的默认强度（owner：「默认改成opus5.5max」）────────────

import { getDefaultEffort, setDefaultEffort, effectiveEffort } from '../src/runtime/prefs.js';
import { tmpDir } from './helpers.js';

test('默认强度：读 config.json 的 defaultEffort，按 agent；没配、配错都是 null', () => {
  const dir = tmpDir('baton-defeffort-');
  assert.equal(getDefaultEffort('claude', { dir }), null, '没有 config.json');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ defaultEffort: { claude: 'max', codex: 'bogus' } }));
  assert.equal(getDefaultEffort('claude', { dir }), 'max');
  assert.equal(getDefaultEffort('codex', { dir }), null, '认不得的档位当没配，不把它塞进 argv');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('默认强度：写的时候保留 config.json 里别的键', () => {
  // 那个文件里还躺着 allowSend、publicUrl、permissionMode——改一个冲掉别的，后果是发送被关、权限回默认
  const dir = tmpDir('baton-defeffort-');
  const before = { allowSend: true, publicUrl: 'https://x', permissionMode: { claude: 'bypass', codex: 'bypass' } };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(before));
  setDefaultEffort('claude', 'max', { dir });
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(after, { ...before, defaultEffort: { claude: 'max' } });
  setDefaultEffort('claude', null, { dir });
  assert.equal(getDefaultEffort('claude', { dir }), null, '传 null 就是清掉，回到 CLI 自己的默认');
  assert.throws(() => setDefaultEffort('claude', 'turbo', { dir }), /turbo/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('effectiveEffort：会话自己选的优先；只有模型也没选时才用整台电脑的默认', () => {
  assert.equal(effectiveEffort({ model: null, effort: null, fallback: 'max' }), 'max');
  assert.equal(effectiveEffort({ model: null, effort: 'low', fallback: 'max' }), 'low');
  // 默认强度是配给默认模型的；换了模型就交给那个模型自己的默认
  assert.equal(effectiveEffort({ model: 'claude-sonnet-5', effort: null, fallback: 'max' }), null);
  assert.equal(effectiveEffort({ model: 'claude-sonnet-5', effort: 'high', fallback: 'max' }), 'high');
  assert.equal(effectiveEffort({ model: null, effort: null, fallback: null }), null);
});
