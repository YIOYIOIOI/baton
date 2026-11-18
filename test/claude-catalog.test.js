import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeCatalog, claudeCatalog } from '../src/agent/catalog.js';
import { discoverModels, clearModelCache, claudeEffortPins } from '../src/models.js';

/*
  模型列表从 Claude Code 本地缓存目录读取并去重：

  避免与别名 opus / sonnet / fable 重复展示；
  下面的夹具是 ~/.claude/cache/model-catalog/<组织>-…-cc.json 的形状，
  字段删到只剩用得上的。
*/

const effort = (levels, def) => ({
  thinking: { type: 'effort' },
  runtime: { max_input_tokens: 1e6, effort_levels: levels, default_effort: def },
});
const FIVE = ['low', 'medium', 'high', 'xhigh', 'max'];
const ALL = ['first_party', 'anthropic_aws', 'bedrock', 'vertex', 'foundry', 'mantle', 'gateway'];

const CATALOG = {
  version: 2,
  catalog: {
    surface: 'cc',
    state: { id: 'cc', model: 'claude-opus-5-5', selection_source: 'global_default' },
    config: {
      id: 'cc',
      models: [
        { id: 'claude-opus-5-5', name: 'Opus 5.5', description: 'For complex work and everyday tasks', section: 'main', offered_on: ALL, ...effort(FIVE, 'medium') },
        { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', description: 'Most efficient for simpler tasks', section: 'main', offered_on: ALL, ...effort(FIVE, 'medium') },
        {
          id: 'claude-fable-5-2', name: 'Fable 5.2', description: 'For your toughest challenges', section: 'main', offered_on: ALL,
          notice: { text: 'Fable is the most capable model and draws down usage much faster than Opus' },
          ...effort(FIVE, 'medium'),
        },
        { id: 'claude-haiku-5-5', name: 'Haiku 5.5', description: 'Fastest for quick answers', section: 'main', offered_on: ALL, ...effort(FIVE, 'medium') },
        {
          id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', section: 'overflow', offered_on: ALL,
          thinking: { type: 'none' }, runtime: { max_input_tokens: 200000 },
        },
        { id: 'claude-opus-4-6', name: 'Opus 4.6', section: 'overflow', offered_on: ALL, ...effort(['low', 'medium', 'high', 'max'], 'high') },
        // 下面三种 /model 都不列：禁用的、deprecated 的、这条路线不供的
        { id: 'claude-opus-4-1', name: 'Opus 4.1', section: 'deprecated', offered_on: ALL },
        { id: 'claude-x-off', name: 'X', section: 'overflow', disabled: true, offered_on: ALL },
        { id: 'claude-bedrock-only', name: 'B', section: 'overflow', offered_on: ['bedrock'] },
        // 说明认不得的就原样给
        { id: 'claude-new-1', name: 'New 1', description: 'Brand new thing', section: 'overflow', offered_on: ALL, ...effort(FIVE, 'high') },
      ],
      provider_alias_targets: {
        opus: { default: 'claude-opus-5-5', per_provider: { gateway: 'claude-opus-4-7' } },
        sonnet: { default: 'claude-sonnet-5-5' },
        fable: { default: 'claude-fable-5-2' },
        haiku: { default: 'claude-haiku-5-5' },
      },
    },
  },
};

test('parseClaudeCatalog：照 /model 的过滤与分区，说明换成中文，强度逐模型', () => {
  const c = parseClaudeCatalog(JSON.stringify(CATALOG));
  assert.deepEqual(c.models.map((m) => [m.id, m.hidden]), [
    ['claude-opus-5-5', false],
    ['claude-sonnet-5-5', false],
    ['claude-fable-5-2', false],
    ['claude-haiku-5-5', false],
    ['claude-haiku-4-5-20251001', true],
    ['claude-opus-4-6', true],
    ['claude-new-1', true],
  ]);
  const by = Object.fromEntries(c.models.map((m) => [m.id, m]));
  assert.equal(by['claude-opus-5-5'].name, 'Opus 5.5');
  assert.equal(by['claude-opus-5-5'].desc, '复杂的活、日常的活都行');
  assert.equal(by['claude-opus-5-5'].defaultEffort, 'medium');
  assert.equal(by['claude-fable-5-2'].desc, '最难的活交给它 · 耗额度比 Opus 快得多');
  // Opus 4.6 没有 xhigh——五档一刀切会给出一个它不认的值
  assert.deepEqual(by['claude-opus-4-6'].efforts, ['low', 'medium', 'high', 'max']);
  // Haiku 4.5 不能调强度：空表是「确知没有」
  assert.deepEqual(by['claude-haiku-4-5-20251001'].efforts, []);
  assert.equal(by['claude-haiku-4-5-20251001'].desc, '不能调思考强度 · 200K 上下文');
  assert.equal(by['claude-new-1'].desc, 'Brand new thing');
  assert.deepEqual(c.aliases, {
    opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', fable: 'claude-fable-5-2', haiku: 'claude-haiku-5-5',
  });
});

test('parseClaudeCatalog：别名按路线取 per_provider', () => {
  assert.equal(parseClaudeCatalog(CATALOG, { provider: 'gateway' }).aliases.opus, 'claude-opus-4-7');
});

test('parseClaudeCatalog：坏输入返回 null，不抛', () => {
  assert.equal(parseClaudeCatalog('{坏的'), null);
  assert.equal(parseClaudeCatalog({}), null);
  assert.equal(parseClaudeCatalog({ catalog: { config: {} } }), null);
});

function homeWith(files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-cc-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
  }
  return home;
}

const CAT_DIR = path.join('.claude', 'cache', 'model-catalog');

test('claudeCatalog：一个组织一份，挑当前登录的那个组织', () => {
  const other = structuredClone(CATALOG);
  other.catalog.config.models = other.catalog.config.models.slice(0, 1);
  const home = homeWith({
    [path.join(CAT_DIR, 'org-a-111-cc.json')]: CATALOG,
    [path.join(CAT_DIR, 'org-b-222-cc.json')]: other,
    [path.join(CAT_DIR, 'published-floor.json')]: { version: 1 },
    '.claude.json': { oauthAccount: { organizationUuid: 'org-a' } },
  });
  // 让 org-b 那份更新：只按时间挑就会挑错
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(home, CAT_DIR, 'org-b-222-cc.json'), later, later);
  assert.equal(claudeCatalog({ home }).models.length, 7);
  fs.rmSync(home, { recursive: true, force: true });
});

test('claudeCatalog：没有目录缓存（旧版 Claude Code）返回 null', () => {
  const home = homeWith({});
  assert.equal(claudeCatalog({ home }), null);
  fs.rmSync(home, { recursive: true, force: true });
});

const NO_CODEX = async () => [];

test('discoverModels：直连且目录在——照目录列，别名一个不放，就是 /model 那张表', async () => {
  const home = homeWith({
    [path.join(CAT_DIR, 'org-a-111-cc.json')]: CATALOG,
    // 跑过 Opus 4.6（在「更多」里）、Opus 4.1（目录里已没有）
    [path.join('.claude', 'projects', 'p', 's.jsonl')]: ['claude-opus-5-5', 'claude-opus-4-6', 'claude-opus-4-1']
      .map((model) => JSON.stringify({ message: { model } })).join('\n'),
    [path.join('.claude', 'settings.json')]: { env: { ANTHROPIC_CUSTOM_MODEL_OPTION: 'claude-custom-9' } },
  });
  clearModelCache();
  const m = await discoverModels({ home, force: true, catalog: NO_CODEX, env: {} });
  assert.deepEqual(m.claude.map((x) => x.id), [
    'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-haiku-5-5',
    'claude-haiku-4-5-20251001', 'claude-opus-4-6', 'claude-new-1',
    // owner 自己在 settings.json 里填的，补在最后
    'claude-custom-9',
  ]);
  const ids = new Set(m.claude.map((x) => x.id));
  for (const alias of ['opus', 'sonnet', 'fable']) assert.ok(!ids.has(alias), `${alias} 和具体型号重复`);
  assert.ok(!ids.has('claude-opus-4-1'), '目录里没有的不列');
  const o46 = m.claude.find((x) => x.id === 'claude-opus-4-6');
  assert.equal(o46.seen, true);
  assert.equal(o46.hidden, false, '跑过的不藏，哪怕在「更多」里');
  assert.equal(o46.listed, true);
  assert.equal(m.claude.find((x) => x.id === 'claude-custom-9').listed, false);
  clearModelCache();
  fs.rmSync(home, { recursive: true, force: true });
});

test('discoverModels：走中转时目录不算数，但别名指向的型号已在表里就不再放', async () => {
  const home = homeWith({
    [path.join(CAT_DIR, 'org-a-111-cc.json')]: CATALOG,
    [path.join('.claude', 'projects', 'p', 's.jsonl')]: JSON.stringify({ message: { model: 'claude-opus-5-5' } }),
  });
  clearModelCache();
  const m = await discoverModels({
    home, force: true, catalog: NO_CODEX, env: { ANTHROPIC_BASE_URL: 'https://relay.example' },
  });
  assert.deepEqual(m.claude.map((x) => x.id), ['claude-opus-5-5', 'sonnet', 'fable']);
  clearModelCache();
  fs.rmSync(home, { recursive: true, force: true });
});

/*
  owner 在 /model 里给 Opus 5.5 存过 xhigh（~/.claude/settings.json 的
  modelSettings.claude-opus-5-5.effortLevel）。不读它，界面会说「默认 · 中」，
  而 CLI 真跑起来是 xhigh。
*/
test('claudeEffortPins：键归一（[1m]、别名），同一型号精确键优先', () => {
  const pins = claudeEffortPins(JSON.stringify({
    effortLevel: 'high',
    modelSettings: {
      'claude-opus-5-5[1m]': { effortLevel: 'low' },
      'claude-opus-5-5': { effortLevel: 'xhigh' },
      sonnet: { effortLevel: 'max' },
      'claude-haiku-5-5': { autoCompactWindow: 1 },
    },
  }), { sonnet: 'claude-sonnet-5-5' });
  assert.deepEqual(pins.byModel, { 'claude-opus-5-5': 'xhigh', 'claude-sonnet-5-5': 'max' });
  assert.equal(pins.top, 'high');
  assert.deepEqual(claudeEffortPins('{坏的'), { byModel: {}, top: null });
});

test('discoverModels：每个模型的默认强度叠上 owner 存过的那档，模型不认的档不算', async () => {
  const home = homeWith({
    [path.join(CAT_DIR, 'org-a-111-cc.json')]: CATALOG,
    [path.join('.claude', 'settings.json')]: {
      modelSettings: {
        'claude-opus-5-5': { effortLevel: 'xhigh' },
        // Opus 4.6 没有 xhigh：存了也不会照发，报目录默认
        'claude-opus-4-6': { effortLevel: 'xhigh' },
      },
    },
  });
  clearModelCache();
  const m = await discoverModels({ home, force: true, catalog: NO_CODEX, env: {} });
  const eff = (id) => m.claude.find((x) => x.id === id).defaultEffort;
  assert.equal(eff('claude-opus-5-5'), 'xhigh');
  assert.equal(eff('claude-sonnet-5-5'), 'medium');
  assert.equal(eff('claude-opus-4-6'), 'high');
  assert.equal(eff('claude-haiku-4-5-20251001'), null);
  clearModelCache();
  fs.rmSync(home, { recursive: true, force: true });
});
