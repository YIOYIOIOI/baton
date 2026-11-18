import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AGENTS, listModes, isMode, getMode, getModes, setMode, modeFlags, needsSandbox,
} from '../src/permission.js';
import { parseDoctor } from '../src/agent/sandbox.js';
import {
  buildClaudeArgs, buildClaudeNewArgs, buildCodexArgs, buildCodexNewArgs,
  buildAntigravityArgs, buildAntigravityNewArgs,
} from '../src/agent/args.js';
import { readPermission, writePermission } from '../src/http/handlers/settings.js';
import { tmpDir } from './helpers.js';

const UUID = '11111111-2222-4333-8444-555555555555';
const tmp = () => tmpDir('baton-perm-');

// ── 档位本身 ────────────────────────────────────

/**
 * 两边的可选集**必须不同**。
 *
 * 原来是共用的三档，于是 Codex 的「只读」和 Claude 的「只出方案」这两样各自
 * 独有、而且实测有用的能力一个都表达不出来。owner 的原话：
 * 「claude 和 codex 的权限是不同的啊」。
 */
test('两个 agent 各有各的档位，互不通用', () => {
  assert.deepEqual(AGENTS, ['claude', 'codex', 'antigravity']);
  assert.deepEqual(listModes('claude').map((o) => o.id), ['default', 'plan', 'edits', 'bypass']);
  assert.deepEqual(listModes('codex').map((o) => o.id), ['default', 'read', 'edits', 'bypass']);
  assert.deepEqual(listModes('antigravity').map((o) => o.id), ['default', 'plan', 'edits', 'auto', 'bypass']);

  // 各自独有的那一档，在对面不成立——这正是拆开的理由
  assert.equal(isMode('claude', 'plan'), true);
  assert.equal(isMode('codex', 'plan'), false, 'codex 没有 plan');
  assert.equal(isMode('codex', 'read'), true);
  assert.equal(isMode('claude', 'read'), false, 'claude 没有只读档');

  for (const bad of ['', 'Bypass', 'acceptEdits', 'rm -rf /', null, 0, {}]) {
    for (const a of AGENTS) {
      assert.equal(isMode(a, bad), false, `${a} / ${JSON.stringify(bad)} 不该被当成档位`);
    }
  }
});

/**
 * 每一档都要有一句讲**后果**的话。
 *
 * 权限是这个 App 里唯一一处「点错了会真的损失东西」的设置，而档位名本身
 * （「只读」「只能写工作区」）说不清后果。缺一句就是让人凭猜。
 */
test('每一档都带一句后果说明', () => {
  for (const a of AGENTS) {
    for (const o of listModes(a)) {
      assert.ok(o.label && o.label.length <= 8, `${a}/${o.id} 的名字要短`);
      assert.ok(o.body && o.body.length >= 10, `${a}/${o.id} 缺少后果说明`);
    }
  }
});

/**
 * 要沙箱的那几档必须标出来。
 *
 * 实测：Codex 的沙箱没做提权预置时，`--sandbox workspace-write` **挂住 150 秒**
 * 没有任何回应。挂住比失败糟得多——手机上点下去，这一轮再也不会回来。
 */
test('要沙箱的档位标了 needsSandbox，bypass 不需要', () => {
  assert.equal(needsSandbox('codex', 'edits'), true);
  assert.equal(needsSandbox('codex', 'read'), true);
  assert.equal(needsSandbox('codex', 'default'), true);
  assert.equal(needsSandbox('codex', 'bypass'), false, 'bypass 明确不沙箱化，不受预置影响');
  // claude 不走 codex 的沙箱，一档都不该标
  for (const o of listModes('claude')) assert.equal(o.needsSandbox, false);
});

/** doctor 的输出是给人看的，所以匹配不上时要落到 unknown，不能当成 ready。 */
test('沙箱状态解析：认得出坏，认不出时不说好', () => {
  assert.equal(parseDoctor('  ⚠ sandbox   elevated Windows sandbox provisioning is incomplete or outdated'), 'missing');
  assert.equal(parseDoctor('  ✓ sandbox   elevated Windows sandbox provisioning is current'), 'ready');
  assert.equal(parseDoctor('随便什么别的输出'), 'unknown');
  assert.equal(parseDoctor(''), 'unknown');
  assert.equal(parseDoctor(null), 'unknown');
});

test('读不出来一律当 default，不抛', () => {
  const dir = tmp();
  assert.equal(getMode('claude', { dir }), 'default', '没有 config.json');
  fs.writeFileSync(path.join(dir, 'config.json'), '{ 坏掉的 json');
  assert.equal(getMode('claude', { dir }), 'default', '坏文件');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ permissionMode: { claude: 'nope' } }));
  assert.equal(getMode('claude', { dir }), 'default', '非法值');
  // codex 没有 plan 这一档，串台的值也要落回 default
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ permissionMode: { codex: 'plan' } }));
  assert.equal(getMode('codex', { dir }), 'default', 'claude 独有的档位不该在 codex 上生效');
});

/**
 * 旧的标量写法要还能读。
 *
 * 升级之前 `permissionMode` 是一个字符串（三档共用）。盘上已经有这种文件了，
 * 读成 default 就等于**悄悄把 owner 开着的 bypass 关掉**——那反倒是好的方向，
 * 但「设置自己变了」这件事本身不可接受：下次他以为还开着。
 */
test('旧的标量 permissionMode 读成两边都用它', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ permissionMode: 'bypass' }));
  assert.deepEqual(getModes({ dir }), { claude: 'bypass', codex: 'bypass', antigravity: 'bypass' });

  // 只改一边时，旧标量要先摊开——否则另一边会被丢掉
  setMode('claude', 'plan', { dir });
  assert.deepEqual(getModes({ dir }), { claude: 'plan', codex: 'bypass', antigravity: 'bypass' });
});

/**
 * 写回去**不能**把别的键冲掉。
 *
 * 整份覆盖会抹掉 owner 手写的 publicUrl / workspacesRoot / allowSend——
 * 那是拿一个开关去毁掉整份配置，而且他要等到下次重启才会发现。
 */
test('写档位保留 config.json 里其余的键', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    publicUrl: 'https://baton.example', allowSend: false, port: 3999,
  }));
  setMode('claude', 'bypass', { dir });

  const after = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  // 只写改动的那一边。缺省即 default，不往盘上塞一堆没人设过的默认值——
  // 那会让「他从没改过」和「他改成了默认」在文件里长得一样
  assert.deepEqual(after.permissionMode, { claude: 'bypass' });
  assert.deepEqual(getModes({ dir }), { claude: 'bypass', codex: 'default', antigravity: 'default' });
  assert.equal(after.publicUrl, 'https://baton.example');
  assert.equal(after.allowSend, false);
  assert.equal(after.port, 3999);
});

test('写非法档位直接抛，不写盘', () => {
  const dir = tmp();
  assert.throws(() => setMode('claude', 'danger-full-access', { dir }));
  // 串台的也要抛：codex 的 read 档在 claude 上不存在
  assert.throws(() => setMode('claude', 'read', { dir }));
  assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
});

// ── 映射到 CLI ──────────────────────────────────

/**
 * argv 的纪律（见 agent/args.js 抬头）：只放程序自控的内容。
 * 档位是**查表**得到的，不是校验过的字符串——表里没有的键返回空数组，
 * 所以再离谱的输入也进不了 argv。
 */
test('未知档位映射成空参数，不会漏进 argv', () => {
  for (const bad of ['bypass; rm -rf /', '--dangerously-skip-permissions', undefined, null]) {
    assert.deepEqual(modeFlags('claude', bad), []);
    assert.deepEqual(modeFlags('codex', bad), []);
  }
  assert.deepEqual(modeFlags('unknown-agent', 'bypass'), []);
});

test('default 档不给两个 agent 追加任何参数', () => {
  const c = buildClaudeArgs({ sessionId: UUID, permissionMode: 'default' });
  const x = buildCodexArgs({ threadId: UUID, permissionMode: 'default' });
  assert.deepEqual(c, buildClaudeArgs({ sessionId: UUID }));
  assert.deepEqual(x, buildCodexArgs({ threadId: UUID }));
});

test('每一档落到实测过的那个开关上', () => {
  // 这几个串抄自 `claude --help` / `codex exec --help`，并且每一档都跑过一次
  // 真实调用验证过行为（判据是磁盘副作用，不是 agent 自己的说辞）。
  // 拼错一个字母不会报错，只会**静默地不生效**——所以钉在这儿。
  assert.deepEqual(
    buildClaudeArgs({ sessionId: UUID, permissionMode: 'edits' }).slice(-2),
    ['--permission-mode', 'acceptEdits'],
  );
  assert.deepEqual(
    buildClaudeArgs({ sessionId: UUID, permissionMode: 'bypass' }).slice(-1),
    ['--dangerously-skip-permissions'],
  );
  assert.deepEqual(
    buildCodexArgs({ threadId: UUID, permissionMode: 'edits' }).slice(-2),
    ['--sandbox', 'workspace-write'],
  );
  assert.deepEqual(
    buildCodexArgs({ threadId: UUID, permissionMode: 'bypass' }).slice(-1),
    ['--dangerously-bypass-approvals-and-sandbox'],
  );
  // 两边各自独有的那一档
  assert.deepEqual(
    buildClaudeArgs({ sessionId: UUID, permissionMode: 'plan' }).slice(-2),
    ['--permission-mode', 'plan'],
  );
  assert.deepEqual(
    buildCodexArgs({ threadId: UUID, permissionMode: 'read' }).slice(-2),
    ['--sandbox', 'read-only'],
  );
  // 串台的档位不该生出参数：claude 没有 read，codex 没有 plan
  assert.deepEqual(
    buildClaudeArgs({ sessionId: UUID, permissionMode: 'read' }),
    buildClaudeArgs({ sessionId: UUID }),
  );
  assert.deepEqual(
    buildCodexArgs({ threadId: UUID, permissionMode: 'plan' }),
    buildCodexArgs({ threadId: UUID }),
  );
  // antigravity 各自档位
  assert.deepEqual(
    buildAntigravityArgs({ sessionId: UUID, permissionMode: 'plan' }).slice(-2),
    ['--mode', 'plan'],
  );
  assert.deepEqual(
    buildAntigravityArgs({ sessionId: UUID, permissionMode: 'edits' }).slice(-2),
    ['--mode', 'accept-edits'],
  );
  assert.deepEqual(
    buildAntigravityArgs({ sessionId: UUID, permissionMode: 'auto' }).slice(-2),
    ['--mode', 'auto'],
  );
  assert.deepEqual(
    buildAntigravityArgs({ sessionId: UUID, permissionMode: 'bypass' }).slice(-1),
    ['--dangerously-skip-permissions'],
  );
  assert.deepEqual(
    buildAntigravityArgs({ sessionId: UUID, permissionMode: 'read' }),
    buildAntigravityArgs({ sessionId: UUID }),
  );
  assert.deepEqual(
    buildAntigravityArgs({ sessionId: UUID, model: 'pro', effort: 'high' }),
    buildAntigravityArgs({ sessionId: UUID, model: 'pro' }),
    'tier 别名不传 --effort，免得 agy 报错退出',
  );
});

test('新建会话那两条路径同样吃档位', () => {
  // 只改了续聊那条、忘了新建那条的话，「手机上开了 bypass，新建的会话还在问」——
  // 而那正是最需要它的场合
  assert.deepEqual(
    buildClaudeNewArgs({ sessionId: UUID, permissionMode: 'bypass' }).slice(-1),
    ['--dangerously-skip-permissions'],
  );
  assert.deepEqual(
    buildCodexNewArgs({ permissionMode: 'bypass' }).slice(-1),
    ['--dangerously-bypass-approvals-and-sandbox'],
  );
  assert.deepEqual(
    buildAntigravityNewArgs({ permissionMode: 'bypass' }).slice(-1),
    ['--dangerously-skip-permissions'],
  );
});

// ── 谁能改 ──────────────────────────────────────

const OWNER = { id: 'owner', roots: null };
const GUEST = { id: 'friend', roots: ['C:\\BatonWorkspaces\\friend'] };

/**
 * **访客一旦能开 bypass，工作区隔离当场失效。**
 *
 * 隔离是 Baton 在自己这层按 cwd 过滤；bypass 放开的是 agent 自己的工具闸门。
 * 一个不问就能跑 shell 的 agent，想走出工作区只需要一条 `cd`。
 * 所以这不是「访客权限小一点」，是一道结构性的闸。
 */
// 端点会去问 codex doctor，测试里一律注入，绝不真的 spawn 子进程
const READY = async () => 'ready';
const MISSING = async () => 'missing';

test('访客改不了档位', async () => {
  const r = await writePermission({ principal: GUEST, mode: 'bypass', sandbox: READY });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'not_owner');
});

test('访客能读到两边的档位，但 canSet 恒为 false', async () => {
  const r = await readPermission({ principal: GUEST, sandbox: READY });
  assert.equal(r.status, 200);
  assert.equal(r.body.canSet, false);
  // 他需要知道当前档位——否则「我的操作为什么被拒」在界面上无从解释
  for (const a of AGENTS) {
    assert.ok(isMode(a, r.body.agents[a].mode), `${a} 的档位要能读到`);
    assert.ok(r.body.agents[a].options.length > 0);
  }
});

/**
 * 沙箱没装好时，要沙箱的那几档**不能让人选中**。
 *
 * 这不是啰嗦：实测那几档会挂住 150 秒没有任何回应。在手机上点下去然后等一个
 * 永远不回来的回复，是这个 App 能给出的最差的一种反馈。
 */
test('沙箱缺失时禁掉相关档位，并说明原因', async () => {
  const r = await readPermission({ principal: OWNER, sandbox: MISSING });
  const byId = Object.fromEntries(r.body.agents.codex.options.map((o) => [o.id, o]));
  assert.equal(byId.edits.available, false);
  assert.ok(byId.edits.unavailable, '禁用了就必须说明为什么');
  assert.equal(byId.bypass.available, true, 'bypass 不走沙箱，不该被连坐');
  assert.equal(r.body.codexSandbox, 'missing');
  // claude 一档都不受影响
  for (const o of r.body.agents.claude.options) assert.equal(o.available, true);

  // 明确拒绝，而不是写进去让它以后挂住
  const w = await writePermission({ principal: OWNER, agent: 'codex', mode: 'edits', sandbox: MISSING });
  assert.equal(w.status, 409);
  assert.equal(w.body.error.code, 'sandbox_missing');
});

/** 状态问不出来时不该连坐——给提示，但不替人做决定。 */
test('沙箱状态 unknown 时不禁用任何档位', async () => {
  const r = await readPermission({ principal: OWNER, sandbox: async () => 'unknown' });
  for (const o of r.body.agents.codex.options) assert.equal(o.available, true);
});

test('owner 能读能改', async () => {
  assert.equal((await readPermission({ principal: OWNER, sandbox: READY })).body.canSet, true);
  const r = await writePermission({ principal: OWNER, mode: 'bad', sandbox: READY });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'bad_mode');
});

/**
 * owner 的判据必须是 `roots === null`，和 scope.js 的边界值同一个。
 * 另立一个 isOwner 标志位就会有两处事实，而它们迟早对不上——
 * 对不上的那一刻，要么访客提权，要么 owner 被自己的机器锁在外面。
 */
test('owner 的判据就是 roots === null，不看 id', async () => {
  // id 叫 owner 但有 roots 的，不是 owner
  const impostor = { id: 'owner', roots: ['C:\\BatonWorkspaces\\x'] };
  const r = await writePermission({ principal: impostor, mode: 'bypass', sandbox: READY });
  assert.equal(r.status, 403);
  // 没有 principal（内部调用）按 owner 处理——和 scope.js 的 inScope 一致
  assert.equal((await readPermission({ principal: null, sandbox: READY })).body.canSet, true);
});

// ── 思考强度 ────────────────────────────────────

/**
 * **两边都有思考强度。**
 *
 * 上一版这条测试钉的是「只有 claude 有」，而那个结论是错的——它是把「我没查到」
 * 写成了「它没有」。owner 指出来之后实测确认：codex 走
 * `-c model_reasoning_effort=<级别>`，三条独立证据见 agent/args.js 抬头。
 *
 * 这条测试本身也是个教训：**它当时是通过的**。一条测试只能证明代码符合我写下的
 * 结论，不能证明结论本身对。
 */
test('两个 agent 都吃 effort，各自落到自己的开关上', () => {
  assert.deepEqual(
    buildClaudeArgs({ sessionId: UUID, effort: 'max' }).slice(-2),
    ['--effort', 'max'],
  );
  assert.deepEqual(
    buildClaudeNewArgs({ sessionId: UUID, effort: 'xhigh' }).slice(-2),
    ['--effort', 'xhigh'],
  );
  assert.deepEqual(
    buildCodexArgs({ threadId: UUID, effort: 'max' }).slice(-2),
    ['-c', 'model_reasoning_effort=max'],
  );
  assert.deepEqual(
    buildCodexNewArgs({ effort: 'ultra' }).slice(-2),
    ['-c', 'model_reasoning_effort=ultra'],
  );
  assert.deepEqual(
    buildAntigravityArgs({ sessionId: UUID, effort: 'xhigh' }).slice(-2),
    ['--effort', 'xhigh'],
  );
  assert.deepEqual(
    buildAntigravityNewArgs({ effort: 'high' }).slice(-2),
    ['--effort', 'high'],
  );
  assert.deepEqual(
    buildAntigravityArgs({ sessionId: UUID, effort: 'ultra' }),
    buildAntigravityArgs({ sessionId: UUID }),
  );
});

/**
 * 闭集。级别要进 argv，所以这里是查表而不是校验字符串——
 * 表里没有的值一个字都不该出现在命令行上。
 */
test('表外的强度值进不了 argv', () => {
  for (const bad of ['UltRa', 'max; rm -rf /', 'high --dangerously-skip-permissions', '', null, undefined, 7]) {
    assert.deepEqual(
      buildClaudeArgs({ sessionId: UUID, effort: bad }),
      buildClaudeArgs({ sessionId: UUID }),
      `claude / ${String(bad)}`,
    );
    assert.deepEqual(
      buildCodexArgs({ threadId: UUID, effort: bad }),
      buildCodexArgs({ threadId: UUID }),
      `codex / ${String(bad)}`,
    );
  }
});

/**
 * 一条 prefs 记录现在有两个字段，**写一个不能冲掉另一个**。
 *
 * 原来是整条替换（那时只有 model，没问题）。加了 effort 之后再那么写，
 * 就是「改模型顺手把思考强度清了」，而且清得无声无息。
 */
test('模型与思考强度互不冲掉', async () => {
  const { setModel, getModel, setEffort, getEffort } = await import('../src/runtime/prefs.js');
  const dir = tmpDir('baton-prefs-');
  const key = 'claude:abc';

  setModel(key, 'claude-opus-5', { dir });
  setEffort(key, 'max', { dir });
  assert.equal(getModel(key, { dir }), 'claude-opus-5', '设 effort 不该冲掉 model');
  assert.equal(getEffort(key, { dir }), 'max');

  setModel(key, 'claude-sonnet-5', { dir });
  assert.equal(getEffort(key, { dir }), 'max', '改 model 不该冲掉 effort');

  // 两个都清空才删掉整条——留个空壳没意义，而这个文件每次发消息都要读
  setModel(key, null, { dir });
  assert.equal(getEffort(key, { dir }), 'max', '清 model 不该连带清掉 effort');
  setEffort(key, null, { dir });
  assert.equal(getModel(key, { dir }), null);
  assert.equal(getEffort(key, { dir }), null);
});

test('setMode 通过临时文件原子落盘，保留兄弟配置且不留 .tmp 残留', () => {
  const dir = tmp();
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    publicUrl: 'https://baton.example.net',
    defaultEffort: { claude: 'high' },
    permissionMode: { codex: 'readOnly' },
  }));

  const renames = [];
  setMode('claude', 'plan', {
    dir,
    rename: (src, dst) => {
      renames.push([src, dst]);
      fs.renameSync(src, dst);
    },
  });

  assert.equal(renames.length, 1, '必须走临时文件 + rename 原子替换');
  assert.match(renames[0][0], /\.tmp$/);
  assert.equal(renames[0][1], cfgPath);
  const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.equal(saved.publicUrl, 'https://baton.example.net');
  assert.deepEqual(saved.defaultEffort, { claude: 'high' });
  assert.deepEqual(saved.permissionMode, { codex: 'readOnly', claude: 'plan' });
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
});
