import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import {
  antigravityApp,
  antigravityEvents,
  antigravityFirstUserText,
  antigravityHead,
  antigravityTail,
  cwdFromMetadata,
  extractGoalCommand,
  extractSettingsModel,
  extractUserRequest,
  normalizeToolArgs,
} from '../src/antigravity.js';
import { antigravitySessionFiles, encodeKey, sessionRef } from '../src/providers.js';
import { createRepo } from '../src/repo.js';
import { scopeRepo } from '../src/scope.js';
import { eventsFor } from '../src/wire.js';
import { liveStates } from '../src/runtime/live.js';
import { clearInfoCache, fileEdits, readSessionInfo } from '../src/sessioninfo.js';
import { antigravityCommands, clearCommandCache } from '../src/agent/commands.js';
import {
  ensureAntigravityPlugin,
  findLiveBridge,
  resolveAntigravityProjectId,
} from '../src/agent/antigravityBridge.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { BRIDGE_OR_CLI_MISSING_MSG, createdConversationObserver, desktopRecovery, desktopWorkspaceIdentity, sameDesktopWorkspace, runAntigravityAcpTurn, runAntigravityTurn } from '../src/agent/antigravityRun.js';
import { boundCreationKey, mayClaimCreation, readCreation, reserveCreation, saveCreation, unboundCreationRecovery } from '../src/runtime/creations.js';
import { getEffort, getModel } from '../src/runtime/prefs.js';
import { listTurns, recoverTurn, startTurn } from '../src/runtime/turns.js';
import { antigravityModelSupportsEffort } from '../src/agent/args.js';
import {
  clearAntigravityCatalogCache,
  parseAntigravityAcpLoad,
  parseAntigravityModels,
} from '../src/agent/catalog.js';
import { createSession } from '../src/http/handlers/create.js';
import { tmpDir, writeJsonl } from './helpers.js';

function createSummaryDb(dbFile, rows) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        workspace_uris TEXT,
        project_id TEXT,
        status TEXT,
        not_fully_idle INTEGER,
        nesting_depth INTEGER,
        killed INTEGER,
        parent_conversation_id TEXT,
        last_modified_time TEXT
      );
    `);
    const stmt = db.prepare(`
      INSERT INTO conversation_summaries (
        conversation_id, title, workspace_uris, project_id, status,
        not_fully_idle, nesting_depth, killed, parent_conversation_id, last_modified_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of rows) {
      stmt.run(
        r.id,
        r.title ?? '',
        r.workspaceUris ?? '',
        r.projectId ?? '',
        r.status ?? 'CASCADE_RUN_STATUS_IDLE',
        r.notFullyIdle ?? 0,
        r.nestingDepth ?? 0,
        r.killed ?? 0,
        r.parentId ?? '',
        r.lastModifiedTime ?? new Date().toISOString(),
      );
    }
  } finally {
    db.close();
  }
}

test('桌面轮询按会话和产品过滤 SQLite 摘要，同时支持直接传产品目录', () => {
  const root = tmpDir();
  for (const product of ['antigravity', 'antigravity-ide']) {
    createSummaryDb(path.join(root, product, 'conversation_summaries.db'), [
      { id: 'wanted', title: product }, { id: 'other' },
    ]);
  }
  const selection = { directories: ['antigravity', ''], conversationId: 'wanted' };
  const desktop = antigravityApp({ root, ...selection });
  assert.deepEqual([...desktop.summaries.keys()], ['wanted']);
  assert.deepEqual([...desktop.byDirectory.keys()], ['antigravity']);
  assert.equal(desktop.summaries.get('wanted').title, 'antigravity');
  const direct = antigravityApp({ root: path.join(root, 'antigravity'), ...selection });
  assert.deepEqual([...direct.summaries.keys()], ['wanted']);
  assert.equal(direct.summaries.get('wanted').title, 'antigravity');
  assert.ok(antigravityApp({ root }).summaries.has('other'));
});

test('antigravity 解析辅助函数与无状态 step 配对', () => {
  const raw = [
    '<USER_REQUEST>\n实现 Antigravity 适配\n</USER_REQUEST>',
    '<ADDITIONAL_METADATA>\nCommand Working Directory: C:\\workspace\\baton\n</ADDITIONAL_METADATA>',
    '<USER_SETTINGS_CHANGE>\nThe user changed `Model Selection` from `gemini-2.5-pro` to claude-opus-4-6-thinking.\n</USER_SETTINGS_CHANGE>',
  ].join('\n');
  assert.equal(extractUserRequest(raw), '实现 Antigravity 适配');
  assert.equal(cwdFromMetadata(raw), 'C:\\workspace\\baton');
  assert.equal(extractSettingsModel(raw), 'claude-opus-4-6-thinking');
  assert.deepEqual(normalizeToolArgs({ Path: '"src/a.js"', Flags: '["a"]' }), { Path: 'src/a.js', Flags: ['a'] });
  assert.deepEqual(extractGoalCommand('/goal 跑完测试'), { condition: '跑完测试', clear: false });
  assert.deepEqual(extractGoalCommand('/goal clear'), { condition: '', clear: true });

  const records = [
    { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-17T10:00:00Z', content: '<USER_REQUEST>\n修 bug\n</USER_REQUEST>' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-17T10:00:02Z',
      thinking: '先看两个文件',
      content: '正在排查<!-- GOAL_COMPLETE -->',
      input_tokens: 1200,
      output_tokens: 80,
      cache_read_tokens: 300,
      tool_calls: [
        { name: 'read_file', args: { Path: 'c:\\repo\\a.js' } },
        { name: 'run_command', args: { CommandLine: 'npm test' } },
      ],
    },
    { step_index: 2, type: 'GENERIC', created_at: '2026-11-17T10:00:03Z', status: 'DONE', content: 'Tool output:\nok' },
    {
      step_index: 3,
      type: 'GENERIC',
      created_at: '2026-11-17T10:00:04Z',
      status: 'ERROR',
      content: 'Command exited with code 2.\nfail',
    },
    { step_index: 4, type: 'CHECKPOINT', created_at: '2026-11-17T10:00:05Z' },
    { step_index: 5, type: 'ERROR_MESSAGE', created_at: '2026-11-17T10:00:06Z', error: 'quota exceeded' },
  ];

  // 单行切片逐条调用也要与整批结果产生完全相同的 tool.id（step:S+1+i）
  const chunked = records.flatMap((r) => antigravityEvents([r]));
  const batched = antigravityEvents(records);
  assert.deepEqual(chunked.map((e) => [e.id, e.kind, e.tool?.id, e.tool?.failed]), batched.map((e) => [e.id, e.kind, e.tool?.id, e.tool?.failed]));

  const callIds = batched.filter((e) => e.kind === 'tool_call').map((e) => e.tool.id);
  const resPairs = batched.filter((e) => e.kind === 'tool_result').map((e) => [e.tool.id, e.tool.failed ?? false]);
  assert.deepEqual(callIds, ['step:2', 'step:3']);
  assert.deepEqual(resPairs, [['step:2', false], ['step:3', true]]);
  assert.equal(batched.some((e) => e.kind === 'goal' && e.goal?.met === true), true);
  assert.equal(batched.at(-1)?.kind, 'turn_end');
  assert.equal(batched.at(-1)?.error, 'quota exceeded');

  const ref = { agent: 'antigravity', providerId: 'conv-1', relPath: 'antigravity/brain/conv-1/.system_generated/logs/transcript.jsonl' };
  const wire = eventsFor(ref, records);
  assert.equal(wire.some((e) => e.kind === 'tool_call' && e.tool?.id === 'step:3'), true);
});

test('extractGoalCommand 正确返回值与 /baton_goal_continue 过滤', () => {
  assert.equal(extractUserRequest('<baton_goal_continue>\n继续工作'), '');
  const events = antigravityEvents([
    { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\n/goal 完成全部测试\n</USER_REQUEST>' },
  ]);
  assert.equal(events.some((e) => e.kind === 'goal' && e.text === '完成全部测试' && e.goal?.met === false), true);
});

test('antigravitySessionFiles / SQLite 摘要 / createRepo / liveStates', () => {
  const root = tmpDir('baton-agy-repo-');
  const projDir = path.join(root, 'work', 'baton');
  fs.mkdirSync(projDir, { recursive: true });
  const projUri = pathToFileURL(projDir).href;

  const nowIso = new Date().toISOString();
  const staleIso = new Date(Date.now() - 60 * 60_000).toISOString();
  createSummaryDb(path.join(root, 'antigravity', 'conversation_summaries.db'), [
    {
      id: 'conv-main',
      title: '桌面主会话',
      workspaceUris: JSON.stringify([projUri]),
      status: 'CASCADE_RUN_STATUS_IDLE',
      notFullyIdle: 1, // 实测 idle 时也可能为 1，不应标 busy
      lastModifiedTime: nowIso,
    },
    {
      id: 'conv-chat',
      title: '随口问问',
      projectId: 'outside-of-project',
      workspaceUris: '[]',
      status: 'CASCADE_RUN_STATUS_RUNNING',
      lastModifiedTime: nowIso,
    },
    {
      id: 'conv-stale',
      title: '旧会话',
      workspaceUris: JSON.stringify([projUri]),
      status: 'CASCADE_RUN_STATUS_RUNNING',
      lastModifiedTime: staleIso, // 超过 30min 不应标 busy
    },
    {
      id: 'conv-sub',
      title: '',
      workspaceUris: JSON.stringify([projUri]),
      status: 'CASCADE_RUN_STATUS_RUNNING',
      nestingDepth: 1,
      parentId: 'conv-main',
      lastModifiedTime: nowIso,
    },
    {
      id: 'conv-killed',
      title: '已删除会话',
      workspaceUris: JSON.stringify([projUri]),
      killed: 1,
      lastModifiedTime: nowIso,
    },
  ]);

  // 同时放 transcript.jsonl 和 transcript_full.jsonl：应优先选 transcript_full.jsonl
  writeJsonl(root, 'antigravity/brain/conv-main/.system_generated/logs/transcript.jsonl', [
    { step_index: 0, type: 'USER_INPUT', created_at: nowIso, content: '<USER_REQUEST>\n旧精简版\n</USER_REQUEST>' },
  ]);
  const mainFull = writeJsonl(root, 'antigravity/brain/conv-main/.system_generated/logs/transcript_full.jsonl', [
    {
      step_index: 0,
      type: 'USER_INPUT',
      created_at: nowIso,
      content: `<USER_REQUEST>\n第一条消息\n</USER_REQUEST>\nActive Workspaces:\n- ${projDir}`,
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: nowIso,
      status: 'DONE',
      content: '收到。',
    },
  ]);
  writeJsonl(root, 'antigravity/brain/conv-chat/.system_generated/logs/transcript.jsonl', [
    { step_index: 0, type: 'USER_INPUT', created_at: nowIso, content: '<USER_REQUEST>\n随便聊聊\n</USER_REQUEST>' },
  ]);
  writeJsonl(root, 'antigravity-cli/brain/conv-stale/.system_generated/logs/transcript.jsonl', [
    { step_index: 0, type: 'USER_INPUT', created_at: staleIso, content: '<USER_REQUEST>\n超时运行态\n</USER_REQUEST>' },
  ]);
  writeJsonl(root, 'antigravity/brain/conv-sub/.system_generated/logs/transcript.jsonl', [
    { step_index: 0, type: 'USER_INPUT', created_at: nowIso, content: '<USER_REQUEST>\nsubagent\n</USER_REQUEST>' },
  ]);
  writeJsonl(root, 'antigravity/brain/conv-killed/.system_generated/logs/transcript.jsonl', [
    { step_index: 0, type: 'USER_INPUT', created_at: nowIso, content: '<USER_REQUEST>\nkilled\n</USER_REQUEST>' },
  ]);

  // 损坏的 DB 不得抛异常
  fs.mkdirSync(path.join(root, 'antigravity-ide'), { recursive: true });
  fs.writeFileSync(path.join(root, 'antigravity-ide', 'conversation_summaries.db'), 'not-a-db');

  const files = antigravitySessionFiles({ root });
  const mainFile = files.find((f) => f.providerId === 'conv-main');
  assert.equal(mainFile?.file, path.resolve(mainFull));

  const app = antigravityApp({ root });
  assert.equal(app.summaries.get('conv-main')?.title, '桌面主会话');
  assert.equal(path.resolve(app.summaries.get('conv-main')?.cwd ?? ''), path.resolve(projDir));

  const head = antigravityHead([{ type: 'USER_INPUT', content: `<USER_REQUEST>\nhi\n</USER_REQUEST>\nActive Workspaces:\n- ${projDir}` }]);
  assert.equal(head.cwd, projDir);
  assert.equal(antigravityFirstUserText([{ type: 'USER_INPUT', content: '<USER_REQUEST>\n首句\n</USER_REQUEST>' }]), '首句');
  assert.equal(antigravityTail([{ type: 'PLANNER_RESPONSE', created_at: nowIso }]).lastTs, nowIso);

  const ref = sessionRef('antigravity', root, 'antigravity/brain/conv-main/.system_generated/logs/transcript_full.jsonl');
  assert.equal(ref.providerId, 'conv-main');
  assert.ok(ref.key.startsWith('antigravity:'));

  const repo = createRepo({
    claudeRoot: path.join(root, 'no-claude'),
    codexRoot: path.join(root, 'no-codex'),
    registryRoot: path.join(root, 'no-reg'),
    codexStateFile: path.join(root, 'no-codex.json'),
    geminiRoot: root,
  });
  const list = repo.listChains().flatMap((c) => c.members);
  const ids = list.map((m) => m.providerId);
  assert.ok(ids.includes('conv-main'));
  assert.ok(ids.includes('conv-chat'));
  assert.ok(!ids.includes('conv-sub'), 'subagent 不应出现在会话列表');
  assert.ok(!ids.includes('conv-killed'), 'killed 会话不应出现在会话列表');

  const mainMember = list.find((m) => m.providerId === 'conv-main');
  assert.equal(mainMember?.title, '桌面主会话');
  const chatMember = list.find((m) => m.providerId === 'conv-chat');
  assert.equal(chatMember?.project?.key, 'antigravity:chats');
  assert.equal(chatMember?.title, '随口问问');
  assert.equal(chatMember?.titleTier, 1);

  const states = liveStates({ dir: path.join(root, 'no-claude-live'), geminiRoot: root });
  assert.equal(states.get('conv-chat'), 'busy');
  assert.equal(states.get('conv-main'), undefined, 'CASCADE_RUN_STATUS_IDLE 即使 not_fully_idle=1 也不该标 busy');
  assert.equal(states.get('conv-stale'), undefined, '超过 30min 不该标 busy');
  assert.equal(states.get('conv-sub'), undefined, 'subagent 不该标 busy');
});

test('Antigravity 会话仅由宿主工作区授权，正文中的目录不决定归属', () => {
  const root = tmpDir();
  const guestDir = path.join(root, 'guest');
  fs.mkdirSync(guestDir);
  const transcript = (id, product = 'antigravity') => writeJsonl(
    root, `${product}/brain/${id}/.system_generated/logs/transcript.jsonl`,
    [{ type: 'USER_INPUT', content: `<USER_REQUEST>\n文档里的目录\nActive Workspaces:\n- ${guestDir}\n</USER_REQUEST>` }],
  );
  for (const id of ['with-workspace', 'standalone', 'no-summary', 'not-a-path']) transcript(id);
  transcript('other-product', 'antigravity-cli');
  transcript('two-summaries', 'antigravity-cli');
  const workspaceUris = JSON.stringify([pathToFileURL(guestDir).href]);
  createSummaryDb(path.join(root, 'antigravity', 'conversation_summaries.db'), [
    { id: 'with-workspace', workspaceUris },
    { id: 'standalone', workspaceUris: '[]', projectId: 'outside-of-project' },
    { id: 'not-a-path', workspaceUris: JSON.stringify(['outside-of-project']) },
    { id: 'other-product', workspaceUris },
    { id: 'two-summaries', workspaceUris: '[]', lastModifiedTime: '2026-02-01T00:00:00Z' },
  ]);
  createSummaryDb(path.join(root, 'antigravity-cli', 'conversation_summaries.db'), [
    { id: 'two-summaries', workspaceUris, lastModifiedTime: '2026-01-01T00:00:00Z' },
  ]);
  const repo = createRepo({
    geminiRoot: root, claudeRoot: path.join(root, 'claude'), codexRoot: path.join(root, 'codex'),
    registryRoot: path.join(root, 'registry'), codexStateFile: null,
  });
  const guest = scopeRepo(repo, { roots: [guestDir] });
  const members = repo.listChains().flatMap((chain) => chain.members);
  const visible = ['two-summaries', 'with-workspace'];
  assert.equal(members.length, 6);
  assert.deepEqual(guest.listChains().flatMap((c) => c.members.map((m) => m.providerId)).sort(), visible);
  for (const member of members) {
    if (visible.includes(member.providerId)) {
      assert.equal(guest.getSession(member.key)?.cwd, guestDir);
    } else {
      assert.equal(guest.getSession(member.key), null);
      assert.equal(repo.getSession(member.key).cwd, null);
      assert.equal(readSessionInfo(member).cwd, null);
    }
  }
});

test('sessioninfo / fileEdits / antigravityCommands', async () => {
  clearInfoCache();
  clearCommandCache();
  const root = tmpDir('baton-agy-info-');
  const cwd = path.join(root, 'proj');
  fs.mkdirSync(cwd, { recursive: true });

  const file = writeJsonl(root, 'antigravity/brain/c1/.system_generated/logs/transcript.jsonl', [
    {
      step_index: 0,
      type: 'USER_INPUT',
      created_at: '2026-11-17T08:00:00Z',
      content: `<USER_REQUEST>\n/goal 全部变绿\n</USER_REQUEST>\nActive Workspaces:\n- ${cwd}\n<USER_SETTINGS_CHANGE>\nThe user changed \`Model Selection\` from \`gemini-2.5-pro\` to gemini-3-pro.\n</USER_SETTINGS_CHANGE>`,
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-17T08:01:00Z',
      input_tokens: 1000,
      cache_read_tokens: 500,
      output_tokens: 100,
      content: '已完成。<!-- GOAL_COMPLETE -->',
      tool_calls: [
        { name: 'edit_file', args: { Path: path.join(cwd, 'src', 'a.js'), Target: 'a\nb', Replacement: 'a\nc\nd' } },
        { name: 'write_file', args: { Path: path.join(cwd, 'src', 'b.js'), Content: 'x\ny\n' } },
      ],
    },
  ]);

  const member = { agent: 'antigravity', file, cwd };
  const info = readSessionInfo(member, { windowOf: () => 1_000_000 });
  assert.equal(info?.agent, 'antigravity');
  assert.equal(info?.model?.id, 'gemini-3-pro');
  assert.equal(info?.context?.used, 1500);
  assert.equal(info?.context?.window, 1_000_000);
  assert.equal(info?.goal?.condition, '全部变绿');
  assert.equal(info?.goal?.met, true);
  assert.equal(info?.filesTracked, true);
  assert.equal(info?.fileCount, 2);

  const editsA = fileEdits(member, 'src/a.js');
  assert.deepEqual(editsA, [{ ts: '2026-11-17T08:01:00Z', kind: 'edit', before: 'a\nb', after: 'a\nc\nd' }]);
  const editsB = fileEdits(member, 'src/b.js');
  assert.deepEqual(editsB, [{ ts: '2026-11-17T08:01:00Z', kind: 'write', before: '', after: 'x\ny\n' }]);

  const home = path.join(root, 'home');
  const writeSkill = (dir, name, desc) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n`);
  };
  writeSkill(path.join(home, '.gemini', 'antigravity', 'builtin', 'skills', 'plan-helper'), 'plan-helper', 'Builtin skill');
  writeSkill(path.join(home, '.gemini', 'config', 'skills', 'user-skill'), 'user-skill', 'User skill');
  writeSkill(path.join(home, '.gemini', 'config', 'plugins', 'demo', 'skills', 'plug-skill'), 'plug-skill', 'Plugin skill');
  writeSkill(path.join(cwd, '.agents', 'skills', 'proj-skill'), 'proj-skill', 'Project skill');

  const cmds = await antigravityCommands({ cwd, home });
  assert.equal(cmds.stale, false);
  const names = cmds.commands.map((c) => c.name);
  assert.ok(names.includes('goal'));
  assert.ok(names.includes('plan-helper'));
  assert.ok(names.includes('user-skill'));
  assert.ok(names.includes('plug-skill'));
  assert.ok(names.includes('proj-skill'));
});

test('antigravityBridge：插件同期（不碰 config.json）、projectId、探活与清理死登记', async () => {
  const root = tmpDir('baton-agy-bridge-');
  const geminiConfigDir = path.join(root, '.gemini', 'config');
  fs.mkdirSync(geminiConfigDir, { recursive: true });
  const cfgPath = path.join(geminiConfigDir, 'config.json');
  fs.writeFileSync(cfgPath, '{"custom":1}');
  const oldBridge = path.join(geminiConfigDir, 'plugins', 'baton-bridge', 'sidecars', 'bridge');
  fs.mkdirSync(oldBridge, { recursive: true });
  fs.writeFileSync(path.join(oldBridge, 'main.mjs'), '// older installed sidecar');

  const first = ensureAntigravityPlugin({ geminiConfigDir });
  assert.equal(first.changed, true);
  assert.ok(fs.existsSync(path.join(first.destDir, 'plugin.json')));
  assert.ok(fs.existsSync(path.join(first.destDir, 'sidecars', 'bridge', 'main.mjs')));
  assert.ok(fs.existsSync(path.join(oldBridge, 'protocol.mjs')));
  assert.match(fs.readFileSync(path.join(oldBridge, 'main.mjs'), 'utf8'), /protocol\.mjs/);
  assert.equal(fs.readFileSync(cfgPath, 'utf8'), '{"custom":1}', '绝不改写用户的 config.json');

  const second = ensureAntigravityPlugin({ geminiConfigDir });
  assert.equal(second.changed, false);

  const ws = path.join(root, 'repo-one');
  fs.mkdirSync(ws, { recursive: true });
  const createdId = resolveAntigravityProjectId(ws, { geminiConfigDir, createIfMissing: true });
  assert.ok(createdId);
  assert.equal(resolveAntigravityProjectId(ws, { geminiConfigDir }), createdId);

  const batonDir = path.join(root, '.baton');
  fs.mkdirSync(path.join(batonDir, 'antigravity-bridges'), { recursive: true, mode: 0o700 });
  const dead = path.join(batonDir, 'antigravity-bridges', '999999.json');
  fs.writeFileSync(dead, JSON.stringify({ pid: 999999, port: 1, projectId: createdId }), { mode: 0o600 });
  assert.equal(await findLiveBridge({ batonDir, alive: () => false }), null);
  assert.equal(fs.existsSync(dead), false, '死 PID 登记应被清理');
});

test('runAntigravityTurn：Sidecar 桥接、agy 回退与双缺报错', async () => {
  const root = tmpDir('baton-agy-turn-');
  const geminiRoot = path.join(root, '.gemini');
  const geminiConfigDir = path.join(geminiRoot, 'config');
  const batonDir = path.join(root, '.baton');
  const transcript = writeJsonl(geminiRoot, 'antigravity/brain/conv-x/.system_generated/logs/transcript.jsonl', [
    { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nhi\n</USER_REQUEST>' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'hello' },
  ]);
  const dbPath = path.join(geminiRoot, 'antigravity', 'conversation_summaries.db');
  createSummaryDb(dbPath, [
    { id: 'conv-x', title: 'Test', status: 'CASCADE_RUN_STATUS_IDLE', lastModifiedTime: new Date().toISOString() },
  ]);

  const bridgeCalls = [];
  const res = await runAntigravityTurn({
    member: { agent: 'antigravity', providerId: 'conv-x', file: transcript, relPath: 'antigravity/brain/conv-x/transcript.jsonl', cwd: root },
    message: '继续',
    batonDir,
    geminiRoot,
    geminiConfigDir,
    pollMs: 25,
    bridgeFinder: async () => ({ host: '127.0.0.1', port: 12345, token: 't' }),
    bridgeCaller: async (_b, pathname, opts) => {
      bridgeCalls.push({ pathname, body: opts.body });
      // 写入新一轮记录并切为 IDLE
      fs.appendFileSync(transcript, [
        JSON.stringify({ step_index: 2, type: 'USER_INPUT', content: '<USER_REQUEST>\n继续\n</USER_REQUEST>' }),
        JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', content: '完成了', input_tokens: 100, output_tokens: 20, cache_read_tokens: 10 }),
      ].join('\n') + '\n');
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare(`UPDATE conversation_summaries SET status = 'CASCADE_RUN_STATUS_IDLE' WHERE conversation_id = 'conv-x'`).run();
      } finally {
        db.close();
      }
      return { ok: true };
    },
  });
  assert.equal(res.code, 0);
  assert.equal(res.summary.status, 'ok');
  assert.equal(res.summary.sessionId, 'conv-x');
  assert.equal(res.summary.tokens?.input, 100);
  assert.equal(bridgeCalls[0].pathname, '/send-message');

  // 无桥接时走 agy runProcess 回退（含 real stream-json 事件与 stream-json stdin 包装）
  const cliCalls = [];
  const cliRes = await runAntigravityTurn({
    member: { agent: 'antigravity', providerId: '11111111-2222-4333-8444-555555555555', cwd: root },
    message: 'hi cli',
    permissionMode: 'plan',
    effort: 'xhigh',
    batonDir,
    geminiRoot,
    geminiConfigDir,
    bridgeFinder: async () => null,
    run: async (opts) => {
      cliCalls.push(opts);
      return {
        code: 0,
        lines: [
          '{"event":"init","conversation_id":"11111111-2222-4333-8444-555555555555"}',
          '{"event":"step_update","step_update":{"conversation_id":"11111111-2222-4333-8444-555555555555","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"ok"}}',
          '{"event":"result","result":{"conversation_id":"11111111-2222-4333-8444-555555555555","status":"SUCCESS","response":"ok","usage":{"input_tokens":50,"output_tokens":3,"cache_read_tokens":0}}}',
        ],
        stderr: '',
      };
    },
  });
  assert.equal(cliRes.code, 0);
  assert.equal(cliRes.summary.status, 'ok');
  assert.equal(cliRes.summary.tokens?.input_tokens, 50);
  assert.ok(cliCalls[0].args.includes('--input-format=stream-json'));
  assert.ok(cliCalls[0].args.includes('--output-format=stream-json'));
  assert.ok(cliCalls[0].args.includes('--mode'));
  assert.ok(cliCalls[0].args.includes('plan'));
  assert.ok(cliCalls[0].args.includes('--effort'));
  assert.ok(cliCalls[0].args.includes('xhigh'));
  assert.deepEqual(JSON.parse(cliCalls[0].message.trim()), {
    event: 'user',
    message: { role: 'user', content: 'hi cli' },
  });

  // 真实 stream-json RESULT ERROR 判失败
  const cliErrRes = await runAntigravityTurn({
    member: { agent: 'antigravity', providerId: '11111111-2222-4333-8444-555555555555', cwd: root },
    message: 'fail cli',
    batonDir,
    geminiRoot,
    geminiConfigDir,
    bridgeFinder: async () => null,
    run: async () => ({
      code: 1,
      lines: [
        '{"event":"init","conversation_id":"11111111-2222-4333-8444-555555555555"}',
        '{"event":"result","result":{"conversation_id":"11111111-2222-4333-8444-555555555555","status":"ERROR","error":"auth failed"}}',
      ],
      stderr: '',
    }),
  });
  assert.equal(cliErrRes.summary.status, 'failed');
  assert.equal(cliErrRes.summary.error, 'auth failed');

  // 双缺明确报错
  const missing = await runAntigravityTurn({
    member: { agent: 'antigravity', providerId: 'conv-x', cwd: root },
    message: 'fail',
    batonDir,
    geminiRoot,
    geminiConfigDir,
    env: { PATH: '' },
    bridgeFinder: async () => null,
  });
  assert.equal(missing.code, 1);
  assert.equal(missing.summary.error, BRIDGE_OR_CLI_MISSING_MSG);
});

test('catalog：parseAntigravityAcpLoad / parseAntigravityModels 与 antigravityModelSupportsEffort', () => {
  clearAntigravityCatalogCache();
  const acpLoad = {
    sessionId: 's1',
    models: {
      currentModelId: 'gemini-4-carbon-medium',
      availableModels: [
        { modelId: 'gemini-4-carbon-low', name: 'Gemini 4 Carbon (Low)' },
        { modelId: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon (Medium)' },
        { modelId: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon (High)' },
        { modelId: 'gemini-4-hydrogen-low', name: 'Gemini 4 Hydrogen (Low)' },
        { modelId: 'gemini-4-hydrogen-medium', name: 'Gemini 4 Hydrogen (Medium)' },
        { modelId: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen (High)' },
        { modelId: 'gemini-4-hydrogen-xhigh', name: 'Gemini 4 Hydrogen (XHigh)' },
        { modelId: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)' },
        { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
      ],
    },
    configOptions: [
      {
        id: 'model',
        currentValue: 'gemini-4-carbon',
        options: [
          { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
          { value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
          { value: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)' },
          { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
        ],
      },
      { id: 'thought_level', currentValue: 'medium', options: [] },
    ],
    _meta: { antigravity: { tier: { name: 'Google AI Ultra' } } },
  };

  const parsed = parseAntigravityAcpLoad(acpLoad);
  assert.equal(parsed?.tier, 'Google AI Ultra');
  assert.equal(parsed?.contextWindow, 1_048_576);
  assert.equal(parsed?.defaultModel?.id, 'gemini-4-carbon');
  assert.equal(parsed?.defaultModel?.effort, 'medium');
  assert.deepEqual(parsed?.models.find((m) => m.id === 'gemini-4-hydrogen')?.efforts, ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(parsed?.models.find((m) => m.id === 'gemini-pro-orchestrator')?.efforts, []);
  assert.deepEqual(parsed?.models.find((m) => m.id === 'gpt-oss-120b-medium')?.efforts, []);

  const fromText = parseAntigravityModels([
    'gemini-4-carbon-medium\tGemini 4 Carbon (Medium)',
    'gemini-4-carbon-high\tGemini 4 Carbon (High)',
    'gemini-pro-orchestrator\tOrchestrator (Carbon)',
  ].join('\n'));
  assert.deepEqual(fromText?.models.map((m) => [m.id, m.efforts]), [
    ['gemini-4-carbon', ['medium', 'high']],
    ['gemini-pro-orchestrator', []],
  ]);

  assert.equal(antigravityModelSupportsEffort(null), true);
  assert.equal(antigravityModelSupportsEffort('gemini-4-carbon'), true);
  assert.equal(antigravityModelSupportsEffort('pro'), false);
  assert.equal(antigravityModelSupportsEffort('gemini-pro-orchestrator'), false);
  assert.equal(antigravityModelSupportsEffort('gpt-oss-120b-medium'), false);
});

for (const receipt of ['收到', '丢失']) {
test(`桌面桥回执${receipt}时均继续占用会话，越过观察时限直到宿主报告结束`, async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const root = tmpDir();
  const transcript = writeJsonl(root, 'transcript.jsonl', []);
  const dbPath = path.join(root, 'antigravity', 'conversation_summaries.db');
  createSummaryDb(dbPath, [{ id: 'c', status: 'CASCADE_RUN_STATUS_IDLE' }]);
  let handle;
  let settled = false;
  const turn = runAntigravityTurn({
    member: { agent: 'antigravity', providerId: 'c', file: transcript, cwd: root },
    message: '继续工作', isNew: false, batonDir: root, geminiRoot: root, geminiConfigDir: root,
    bridgeFinder: async () => ({}), run: async () => { throw new Error('只应走已注入的桌面桥'); },
    onStart: (h) => { handle = h; },
    bridgeCaller: async () => {
      const active = new DatabaseSync(dbPath);
      try { active.prepare('UPDATE conversation_summaries SET status = ?').run('CASCADE_RUN_STATUS_RUNNING'); }
      finally { active.close(); }
      fs.appendFileSync(transcript, JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '继续工作' }) + '\n');
      if (receipt === '丢失') throw Object.assign(new Error('回执超时'), { deliveryUnknown: true });
    },
    pollMs: 10, maxTurnMs: 20,
  }).then((res) => { settled = true; return res; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handle.canStop, false);
  t.mock.timers.tick(100);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  fs.appendFileSync(transcript, JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: '完成' }) + '\n');
  const db = new DatabaseSync(dbPath);
  try { db.prepare('UPDATE conversation_summaries SET status = ?').run('CASCADE_RUN_STATUS_IDLE'); }
  finally { db.close(); }
  t.mock.timers.tick(60_000);
  assert.equal((await turn).summary.status, 'ok');
});
}

test('已签收续聊只跟随基线后的己方请求，前一轮 DONE、ERROR 与两轮间的空闲均不能结束它', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const root = tmpDir();
  const file = writeJsonl(root, 'transcript.jsonl', [{ step_index: 0, type: 'USER_INPUT', content: '同一条消息' }]);
  const dbFile = path.join(root, 'antigravity', 'conversation_summaries.db');
  createSummaryDb(dbFile, [{ id: 'desktop', status: 'CASCADE_RUN_STATUS_RUNNING' }]);
  const db = new DatabaseSync(dbFile);
  t.after(() => db.close());
  const append = (row) => fs.appendFileSync(file, JSON.stringify(row) + '\n');
  const tick = async () => { t.mock.timers.tick(100); await new Promise((resolve) => setImmediate(resolve)); };
  let settled = false;
  const seen = [];
  const turn = runAntigravityTurn({
    member: { agent: 'antigravity', providerId: 'desktop', file, cwd: root }, message: '同一条消息',
    batonDir: root, geminiRoot: root, geminiConfigDir: root, agyBin: null, pollMs: 10,
    bridgeFinder: async () => ({}), bridgeCaller: async () => {
      append({ step_index: 1, type: 'USER_INPUT', content: '电脑端的任务' });
      append({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', content: '前一轮', output_tokens: 37 });
      append({ step_index: 3, type: 'ERROR_MESSAGE', content: '前一轮失败' });
      return { ok: true };
    },
    onLine: (line) => seen.push(JSON.parse(line)),
  }).then((r) => { settled = true; return r; });
  await new Promise((resolve) => setImmediate(resolve));
  db.prepare('UPDATE conversation_summaries SET status = ?').run('CASCADE_RUN_STATUS_IDLE');
  await tick();
  assert.equal(settled, false);
  append({ step_index: 4, type: 'USER_INPUT', content: '<USER_REQUEST>\n同一条消息\n</USER_REQUEST>' });
  await tick();
  assert.equal(settled, false);
  append({ step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', content: '本轮', output_tokens: 8 });
  await tick();
  const { summary } = await turn;
  assert.equal(summary.status, 'ok');
  assert.equal(summary.tokens.output, 8);
  assert.deepEqual(seen.filter((r) => r.step_index !== undefined).map((r) => r.step_index), [4, 5]);
});

test('桌面桥重启接管后只接受原回合的新消息与宿主终态', () => {
  const root = tmpDir();
  const file = writeJsonl(root, 'antigravity/brain/desktop/.system_generated/logs/transcript.jsonl', [
    { step_index: 0, type: 'USER_INPUT', content: '核查进度' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: '上一轮' },
  ]);
  const dbFile = path.join(root, 'antigravity', 'conversation_summaries.db');
  createSummaryDb(dbFile, [{ id: 'desktop', status: 'CASCADE_RUN_STATUS_RUNNING' }]);
  const turn = { key: 'k', turnId: 'recover-desktop', prompt: '核查进度', monitor: { conversationId: 'desktop', baselineStep: 1, sawRunning: true } };
  const inspect = desktopRecovery({ getSession: () => ({ providerId: 'desktop', file }) }, { geminiRoot: root });
  const beforeInput = new DatabaseSync(dbFile);
  try { beforeInput.prepare('UPDATE conversation_summaries SET status = ?').run('CASCADE_RUN_STATUS_IDLE'); } finally { beforeInput.close(); }
  assert.equal(inspect(turn), null);
  const active = new DatabaseSync(dbFile);
  try { active.prepare('UPDATE conversation_summaries SET status = ?').run('CASCADE_RUN_STATUS_RUNNING'); } finally { active.close(); }
  fs.appendFileSync(file, JSON.stringify({ step_index: 2, type: 'USER_INPUT', content: '核查进度' }) + '\n');
  fs.appendFileSync(file, JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', content: '新一轮' }) + '\n');
  assert.equal(inspect(turn), null);
  const db = new DatabaseSync(dbFile);
  try { db.prepare('UPDATE conversation_summaries SET status = ?').run('CASCADE_RUN_STATUS_IDLE'); } finally { db.close(); }
  assert.equal(inspect(turn).status, 'ok');
});

test('旧轮 RUNNING 期间写入本轮 USER_INPUT 和上一轮终态，首次 IDLE 保持占用，本轮只计自己的输出', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const root = tmpDir();
  const file = writeJsonl(root, 'transcript.jsonl', []);
  const dbFile = path.join(root, 'conversation_summaries.db');
  createSummaryDb(dbFile, [{ id: 'desktop', status: 'CASCADE_RUN_STATUS_RUNNING' }]);
  const db = new DatabaseSync(dbFile);
  t.after(() => db.close());
  const advance = async (status) => {
    db.prepare('UPDATE conversation_summaries SET status = ?').run('CASCADE_RUN_STATUS_' + status);
    t.mock.timers.tick(100);
    await new Promise((resolve) => setImmediate(resolve));
  };
  let settled = false;
  const seen = [];
  const append = (row) => fs.appendFileSync(file, JSON.stringify(row) + '\n');
  const turn = runAntigravityTurn({
    member: { agent: 'antigravity', providerId: 'desktop', file, cwd: root }, message: '同一会话续聊',
    agyBin: null, batonDir: root, geminiRoot: root, geminiConfigDir: root, pollMs: 10,
    onLine: (line) => seen.push(JSON.parse(line)),
    bridgeFinder: async () => ({}), bridgeCaller: async () => {
      append({ step_index: 0, type: 'USER_INPUT', content: '同一会话续聊' });
      append({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: '旧输出', output_tokens: 37 });
      append({ step_index: 2, type: 'ERROR_MESSAGE', content: '旧错误' });
      return { ok: true };
    },
  }).then((r) => { settled = true; return r; });
  await new Promise((resolve) => setImmediate(resolve));
  await advance('IDLE');
  assert.equal(settled, false);
  await advance('RUNNING');
  append({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', content: '新输出', output_tokens: 7 });
  await advance('IDLE');
  const { summary } = await turn;
  assert.equal(summary.status, 'ok');
  assert.equal(summary.tokens.output, 7);
  assert.deepEqual(seen.filter((r) => r.step_index !== undefined).map((r) => r.step_index), [0, 3]);
});

test('停机期间两轮交错，当前 RUNNING 或 IDLE、之前等待 IDLE 或 RUNNING 均如实标记待确认', () => {
  const root = tmpDir();
  const file = writeJsonl(root, 'brain/desktop/.system_generated/logs/transcript.jsonl', [
    { step_index: 0, type: 'USER_INPUT', content: '核查' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: '旧输出', output_tokens: 37 },
    { step_index: 2, type: 'ERROR_MESSAGE', content: '旧错误' },
  ]);
  const dbFile = path.join(root, 'conversation_summaries.db');
  createSummaryDb(dbFile, [{ id: 'desktop', status: 'CASCADE_RUN_STATUS_RUNNING' }]);
  const db = new DatabaseSync(dbFile);
  const set = (status) => db.prepare('UPDATE conversation_summaries SET status = ?').run('CASCADE_RUN_STATUS_' + status);
  const append = (row) => fs.appendFileSync(file, JSON.stringify(row) + '\n');
  const repo = { getSession: () => ({ providerId: 'desktop', file }) };
  try {
    set('IDLE');
    append({ step_index: 3, type: 'ERROR_MESSAGE', content: '迟到的上一轮错误' });
    set('RUNNING');
    for (const current of ['RUNNING', 'IDLE']) {
      if (current === 'IDLE') {
        append({ step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', content: '停机时已有新输出', output_tokens: 7 });
        set('IDLE');
      }
      for (const awaitingIdle of [true, false]) {
        const turn = { key: 'k', turnId: randomUUID(), prompt: '核查', monitor: {
          conversationId: 'desktop', directory: '', baselineStep: -1, userStep: 0,
          awaitingIdle, awaitingRun: !awaitingIdle, ignoreThrough: 2,
        } };
        const result = desktopRecovery(repo, { geminiRoot: root })(turn);
        assert.equal(result.status, 'unconfirmed');
        assert.match(result.error, /结果待确认/);
        assert.equal(result.tokens, null);
        assert.equal(result.eventCount, 0);
      }
    }
  } finally { db.close(); }
});

test('新建回执按可信 cwd 和唯一首轮归属认领，含同项目子目录、并发回执及恢复后的最终归属检查', () => {
  const root = tmpDir();
  const work = path.join(root, 'work');
  const other = path.join(root, 'other');
  for (const dir of [work, other]) fs.mkdirSync(dir);
  const geminiRoot = path.join(root, 'host');
  const db = path.join(geminiRoot, 'antigravity', 'conversation_summaries.db');
  const text = '同一条首轮消息';
  function publish(id, cwd, projectId) {
    createSummaryDb(db, [{ id, workspaceUris: JSON.stringify([cwd]), projectId }]);
    writeJsonl(path.join(geminiRoot, 'antigravity'), `brain/${id}/.system_generated/logs/transcript.jsonl`, [{ step_index: 0, type: 'USER_INPUT', content: text }]);
  }
  publish('wrong-dir', other, 'shared');
  publish('no-project', other, '');
  const evidence = { cwd: work, projectId: 'shared', claimedId: null, baseline: [], delivery: 'unknown' };
  const observing = createdConversationObserver(evidence, text, geminiRoot);
  assert.equal(observing().match, null);
  assert.equal(createdConversationObserver({ ...evidence, projectId: null }, text, geminiRoot)().match, null);
  publish('right-dir', work, 'shared');
  assert.equal(observing().match.id, 'right-dir');
  const first = saveCreation({ turnId: randomUUID(), principalId: 'owner', ownerId: randomUUID(), status: 'unconfirmed', prompt: text, startedAt: Date.now(), cwd: work, evidence }, root);
  const second = saveCreation({ ...first, turnId: randomUUID() }, root);
  const observe = (receipt) => createdConversationObserver(receipt.evidence, text, geminiRoot, (match) => mayClaimCreation(receipt, match, root))().match;
  assert.equal(observe(first), null);
  assert.equal(observe(second), null);
  let resolvedCwd = other;
  const turns = [];
  const repo = { getSession: (key) => ({ key, cwd: resolvedCwd }) };
  const recover = () => unboundCreationRecovery(repo, { dir: root, geminiRoot, onBound: (record) => turns.push(record) })();
  assert.equal(recover(), 2);
  const signed = saveCreation({ ...first, evidence: { ...evidence, claimedId: 'right-dir', delivery: 'accepted' } }, root);
  assert.equal(observe(signed).id, 'right-dir');
  assert.equal(observe(second), null);
  assert.equal(recover(), 2, '写入轮次前重新确认成员的可信目录');
  const reserved = reserveCreation(signed, observe(signed), root);
  assert.equal(reserved.reservation.sessionId, 'right-dir');
  const secondClaim = saveCreation({ ...second, evidence: { ...evidence, claimedId: 'right-dir' } }, root);
  writeJsonl(path.join(geminiRoot, 'antigravity'), 'brain/right-dir/.system_generated/logs/transcript_full.jsonl',
    [{ step_index: 0, type: 'USER_INPUT', content: text }]);
  assert.equal(observe(secondClaim), null, '确认落盘中途退出且宿主换用完整日志时，仍由同一回执持有身份');
  resolvedCwd = work;
  assert.equal(recover(), 1);
  assert.deepEqual(turns.map((turn) => turn.turnId), [first.turnId]);
  assert.equal(readCreation(second.turnId, root).status, 'unconfirmed');
  assert.equal(recover(), 1, '已归属的宿主身份不能再分给另一张回执');
});

test('转录缺失、空文件或尚未写完第一行时，冷恢复尊重已保存的交错状态，即使尚无 userStep', () => {
  const root = tmpDir();
  for (const [n, data] of [null, '', '{"type":'].entries()) {
    for (const phase of ['awaitingIdle', 'awaitingRun']) {
      const file = path.join(root, n + phase + '.jsonl');
      if (data !== null) fs.writeFileSync(file, data);
      const turn = { key: 'k', turnId: randomUUID(), prompt: '待确认', monitor: {
        conversationId: 'desktop', baselineStep: -1, userStep: null, [phase]: true,
      } };
      const inspect = desktopRecovery({ getSession: () => ({ file }) }, { geminiRoot: root });
      assert.equal(inspect(turn).status, 'unconfirmed');
      fs.writeFileSync(file, [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: turn.prompt }),
        JSON.stringify({ step_index: 1, type: 'ERROR_MESSAGE', content: '上一轮的错误' }),
      ].join('\n') + '\n');
      const again = inspect(turn);
      assert.equal(again.status, 'unconfirmed');
      assert.doesNotMatch(again.error, /上一轮的错误/);
    }
  }
});

test('旧已确认回执从紧凑日志 key 还原稳定的产品目录，同宿主完整日志可查询且不能重复领用', () => {
  const dir = tmpDir();
  for (const directory of ['', 'antigravity']) {
    const id = directory ? 'nested' : 'top';
    const prefix = (directory ? directory + '/' : '') + 'brain/' + id + '/.system_generated/logs/';
    const key = encodeKey('antigravity', prefix + 'transcript.jsonl');
    const full = encodeKey('antigravity', prefix + 'transcript_full.jsonl');
    const old = saveCreation({ turnId: randomUUID(), status: 'identified', sessionId: id, key, cwd: dir }, dir);
    const next = { turnId: randomUUID(), status: 'unconfirmed', cwd: dir, prompt: '普通测试', evidence: { cwd: dir, baseline: [] } };
    const match = { id, directory, cwd: dir, key: full };
    assert.equal(mayClaimCreation(next, match, dir), false);
    assert.equal(boundCreationKey(old, { getSession: (candidate) => candidate === full ? { cwd: dir } : null }, dir), full);
    const alternate = directory ? '' : 'antigravity';
    assert.equal(mayClaimCreation(next, { ...match, directory: alternate }, dir), true);
  }
});

test('首轮落盘与回执确认之间重启，完整转录接续已预留或已写下的紧凑日志轮次', () => {
  for (const scenario of ['legacy-written', 'pinned-written', 'pinned-before-write']) {
    const dir = tmpDir();
    const geminiRoot = path.join(dir, 'host');
    const directory = scenario === 'legacy-written' ? '' : 'antigravity';
    const product = path.join(geminiRoot, directory);
    const id = 'from-desktop', prompt = '只发一次';
    const base = (directory ? directory + '/' : '') + 'brain/' + id + '/.system_generated/logs/';
    const compactKey = encodeKey('antigravity', base + 'transcript.jsonl');
    const fullKey = encodeKey('antigravity', base + 'transcript_full.jsonl');
    const ownerId = randomUUID(), turnId = randomUUID();
    let receipt = saveCreation({ turnId, ownerId, startedAt: Date.now(), principalId: 'owner', status: 'unconfirmed',
      cwd: dir, prompt, model: 'desktop-model', effort: 'high', evidence: { baseline: [], cwd: dir, claimedId: id } }, dir);
    if (scenario === 'legacy-written') {
      receipt = saveCreation({ ...receipt, reservation: { directory, sessionId: id } }, dir);
    } else {
      receipt = reserveCreation(receipt, { directory, id, key: compactKey, cwd: dir }, dir);
      assert.equal(readCreation(turnId, dir).reservation.key, compactKey);
    }
    const hadTurn = scenario !== 'pinned-before-write';
    const checkpoint = { conversationId: id, directory, baselineStep: -1, userStep: 0, sawRunning: true, awaitingIdle: false };
    if (hadTurn) startTurn({ key: compactKey, turnId, agent: 'antigravity', prompt, adoptedDesktop: { ownerId, monitor: checkpoint } }, { dir });
    // Only the full transcript exists on the next startup. It still belongs to the same host session.
    const full = writeJsonl(geminiRoot, base + 'transcript_full.jsonl', [
      { step_index: 0, type: 'USER_INPUT', content: prompt },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: '完成', output_tokens: 6 },
    ]);
    createSummaryDb(path.join(product, 'conversation_summaries.db'), [{ id, workspaceUris: JSON.stringify([dir]) }]);
    const repo = { getSession: (key) => key === fullKey ? { key, cwd: dir, file: full, providerId: id } : null };
    const retained = [];
    const recover = unboundCreationRecovery(repo, { dir, geminiRoot, onBound: (turn) => retained.push(turn) });
    assert.equal(recover(), 0);
    assert.deepEqual(retained.map((turn) => [turn.key, turn.turnId]), [[compactKey, turnId]]);
    if (hadTurn) assert.deepEqual(retained[0].monitor, checkpoint);
    assert.equal(readCreation(turnId, dir).key, compactKey);
    assert.equal(boundCreationKey(readCreation(turnId, dir), repo, dir), fullKey);
    assert.equal(getModel(compactKey, { dir }), 'desktop-model');
    assert.equal(getEffort(compactKey, { dir }), 'high');
    assert.equal(getModel(fullKey, { dir }), null);
    assert.equal(getEffort(fullKey, { dir }), null);
    const finished = recoverTurn(retained[0], { dir, inspectMonitor: desktopRecovery(repo, { geminiRoot }) });
    assert.equal(finished.status, 'ok');
    assert.equal(finished.tokens.output, 6);
    assert.deepEqual(listTurns(compactKey, { dir }).map((turn) => [turn.turnId, turn.status]), [[turnId, 'ok']]);
    assert.deepEqual(listTurns(fullKey, { dir }), []);
    assert.equal(recover(), 0);
    assert.equal(retained.length, 1);
  }
});

test('旧工作目录回执能认出系统临时目录和 Windows 短路径，且拒绝可改指的目录链接', () => {
  const root = tmpDir();
  const spelling = path.join(os.tmpdir(), path.basename(root));
  const real = fs.realpathSync.native(root);
  assert.equal(sameDesktopWorkspace(spelling, real), true);
  const child = path.join(real, 'Receipt Workspace');
  fs.mkdirSync(child);
  if (process.platform === 'win32') {
    const short = path.join(real, 'RECEIP~1');
    if (fs.existsSync(short)) assert.equal(sameDesktopWorkspace(short, child), true);
  }
  const alias = path.join(real, 'alias');
  fs.symlinkSync(child, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(sameDesktopWorkspace(alias, child), false);
});

test('新建之前固定真实工作目录身份，区分同名换目录和敏感大小写，允许指向同一目录的别名', (t) => {
  const root = tmpDir(), upper = path.join(root, 'Work'), lower = path.join(root, 'work');
  if (process.platform === 'win32' && process.env.SystemRoot) {
    // This only affects the test's empty temporary directory. Standard users on some
    // Windows installations cannot enable the per-directory NTFS flag.
    spawnSync(path.join(process.env.SystemRoot, 'System32', 'fsutil.exe'), ['file', 'setCaseSensitiveInfo', root, 'enable'],
      { stdio: 'ignore', windowsHide: true, timeout: 2000 });
  }
  fs.mkdirSync(upper);
  const identity = desktopWorkspaceIdentity(upper);
  assert.ok(identity);
  let sensitive = true;
  try { fs.mkdirSync(lower); } catch (err) { if (err.code !== 'EEXIST') throw err; sensitive = false; }
  assert.equal(sameDesktopWorkspace(upper, lower, identity), !sensitive);
  t.diagnostic(sensitive ? '本机将 Work 和 work 视为两个物理目录' : '本机将大小写别名指向同一目录，另以固定文件身份验证区分');
  assert.equal(sameDesktopWorkspace(upper, upper, { path: path.join(path.dirname(identity.path), 'wORK') }), false);
  if (identity.ino) assert.equal(sameDesktopWorkspace(upper, upper, { ...identity, ino: String(BigInt(identity.ino) + 1n) }), false);
  assert.equal(sameDesktopWorkspace(upper, path.join(root, 'missing'), identity), false);
  assert.equal(sameDesktopWorkspace(path.join(root, 'missing'), path.join(root, 'missing')), false);
  const alias = path.join(root, 'alias');
  fs.symlinkSync(upper, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(sameDesktopWorkspace(alias, upper, identity), true);
  const old = path.join(root, 'original');
  fs.renameSync(upper, old);
  fs.mkdirSync(upper);
  if (identity.ino) {
    assert.equal(sameDesktopWorkspace(upper, alias, identity), false);
    assert.equal(sameDesktopWorkspace(old, old, identity), true);
    const receipt = { turnId: randomUUID(), cwd: upper, prompt: '固定初始目录', evidence: { cwd: upper, workspace: identity, baseline: [] } };
    assert.equal(mayClaimCreation(receipt, { id: 'candidate', directory: '', cwd: alias, key: 'candidate' }, root), false);
  }
});

test('桌面桥新会话稍后才落盘时仅跟随与首条消息相符的会话', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const root = tmpDir();
  const db = path.join(root, 'antigravity', 'conversation_summaries.db');
  createSummaryDb(db, []);
  const recordConversation = (id, text) => {
    createSummaryDb(db, [{ id, workspaceUris: JSON.stringify([root]) }]);
    writeJsonl(root, `antigravity/brain/${id}/.system_generated/logs/transcript.jsonl`, [
      { step_index: 0, type: 'USER_INPUT', content: text },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: '完成' },
    ]);
  };
  let settled = false;
  const turn = runAntigravityTurn({
    isNew: true, member: { agent: 'antigravity', cwd: root }, message: '核对工作',
    batonDir: root, geminiRoot: root, geminiConfigDir: root,
    bridgeFinder: async () => ({}), bridgeCaller: async () => ({}),
    pollMs: 10, startTimeoutMs: 20,
  }).then((res) => { settled = true; return res; });
  await new Promise((resolve) => setImmediate(resolve));
  recordConversation('other', '另一项工作的消息');
  t.mock.timers.tick(100);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, '等待身份确认时要继续监控');
  recordConversation('ours', '核对工作');
  t.mock.timers.tick(60_000);
  const { summary } = await turn;
  assert.equal(summary.status, 'ok');
  assert.equal(summary.sessionId, 'ours');
});

test('两种桌面布局同时有同一 ID 时，续聊使用成员自己的日志与 SQLite 行', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const root = tmpDir();
  const rel = 'brain/desktop/.system_generated/logs/transcript.jsonl';
  const files = ['', 'antigravity'].map((dir) => writeJsonl(path.join(root, dir), rel, [
    { step_index: 0, type: 'USER_INPUT', content: '往事' },
  ]));
  const db = path.join(root, 'conversation_summaries.db');
  createSummaryDb(db, [{ id: 'desktop', status: 'CASCADE_RUN_STATUS_IDLE' }]);
  createSummaryDb(path.join(root, 'antigravity', 'conversation_summaries.db'), [{ id: 'desktop', killed: 1 }]);
  let settled = false;
  const turn = runAntigravityTurn({
    member: { agent: 'antigravity', providerId: 'desktop', file: files[0], cwd: root },
    message: '核对', agyBin: null, batonDir: root, geminiRoot: root, geminiConfigDir: root, pollMs: 10,
    bridgeFinder: async () => ({}), bridgeCaller: async () => {
      const direct = new DatabaseSync(db);
      try { direct.prepare('UPDATE conversation_summaries SET status = ?').run('CASCADE_RUN_STATUS_RUNNING'); } finally { direct.close(); }
      for (const [i, file] of files.entries()) {
        fs.appendFileSync(file, JSON.stringify({ step_index: 1, type: 'USER_INPUT', content: '核对' }) + '\n');
        fs.appendFileSync(file, JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', content: '完成', output_tokens: 5 + i }) + '\n');
      }
      return { ok: true };
    },
  }).then((r) => { settled = true; return r; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  const direct = new DatabaseSync(db);
  try { direct.prepare('UPDATE conversation_summaries SET status = ?').run('CASCADE_RUN_STATUS_IDLE'); } finally { direct.close(); }
  t.mock.timers.tick(100);
  const { summary } = await turn;
  assert.equal(summary.status, 'ok');
  assert.equal(summary.tokens.output, 5);
});

test('新建桌面会话从两种布局识别新登记的 ID，根库新会话与嵌套库旧同名会话分开', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const root = tmpDir();
  const nested = path.join(root, 'antigravity');
  const rel = 'brain/reused/.system_generated/logs/transcript.jsonl';
  const rows = (tokens) => [
    { step_index: 0, type: 'USER_INPUT', content: '新建任务' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: '完成', output_tokens: tokens },
  ];
  createSummaryDb(path.join(nested, 'conversation_summaries.db'), [{ id: 'reused' }]);
  writeJsonl(nested, rel, rows(99));
  createSummaryDb(path.join(root, 'conversation_summaries.db'), []);
  let result;
  const turn = runAntigravityTurn({
    isNew: true, member: { agent: 'antigravity', cwd: root }, message: '新建任务',
    agyBin: null, batonDir: root, geminiRoot: root, geminiConfigDir: root,
    bridgeFinder: async () => ({}), bridgeCaller: async () => {
      createSummaryDb(path.join(root, 'conversation_summaries.db'), [{ id: 'reused', workspaceUris: JSON.stringify([root]) }]);
      writeJsonl(root, rel, rows(7));
      return { ok: true };
    },
    pollMs: 10,
  }).then((r) => { result = r; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result?.summary?.tokens?.output, 7);
  await turn;
});

test('runAntigravityAcpTurn：ACP JSON-RPC 流程、切档切模型以及 session/cancel 中止', async () => {
  const seenRpcs = [];
  const killSent = Promise.withResolvers();
  const makeMockSpawn = ({ hangPrompt = false } = {}) => (_cmd, _args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      if (hangPrompt) killSent.resolve(() => child.emit('close', 0));
      else process.nextTick(() => child.emit('close', 0));
    };

    let inBuf = '';
    child.stdin.on('data', (chunk) => {
      inBuf += chunk.toString('utf8');
      let nl;
      while ((nl = inBuf.indexOf('\n')) >= 0) {
        const raw = inBuf.slice(0, nl).trim();
        inBuf = inBuf.slice(nl + 1);
        if (!raw) continue;
        const req = JSON.parse(raw);
        seenRpcs.push({ method: req.method, params: req.params });
        if (req.method === 'initialize') {
          child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: 1 } })}\n`);
        } else if (req.method === 'session/load') {
          child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { sessionId: req.params.sessionId } })}\n`);
        } else if (req.method === 'session/set_mode' || req.method === 'session/set_config_option') {
          child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} })}\n`);
        } else if (req.method === 'session/prompt' && !hangPrompt) {
          child.stdout.write(`${JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: req.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '收到' } } },
          })}\n`);
          child.stdout.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: { stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 5, cachedReadTokens: 30, thoughtTokens: 10 } },
          })}\n`);
        }
      }
    });
    return child;
  };

  const res = await runAntigravityAcpTurn({
    member: { agent: 'antigravity', providerId: 'sess-desktop-1', cwd: tmpDir() },
    message: '你好',
    model: 'gemini-4-carbon',
    effort: 'high',
    permissionMode: 'plan',
    product: 'antigravity',
    agyBin: process.execPath,
    spawnFn: makeMockSpawn(),
  });
  assert.equal(res.code, 0);
  assert.equal(res.summary.status, 'ok');
  assert.equal(res.summary.sessionId, 'sess-desktop-1');
  assert.deepEqual(res.summary.tokens, { input_tokens: 120, output_tokens: 5, cache_read_tokens: 30, thinking_tokens: 10 });
  assert.deepEqual(seenRpcs.map((r) => r.method), [
    'initialize', 'session/load', 'session/set_mode', 'session/set_config_option', 'session/set_config_option', 'session/prompt',
  ]);
  assert.equal(seenRpcs[2].params.modeId, 'plan');
  assert.deepEqual(seenRpcs[3].params, { sessionId: 'sess-desktop-1', configId: 'model', value: 'gemini-4-carbon' });
  assert.deepEqual(seenRpcs[4].params, { sessionId: 'sess-desktop-1', configId: 'thought_level', value: 'high' });

  // 验证 abort 路径发出 session/cancel 并清理子进程
  seenRpcs.length = 0;
  let stopper = null;
  const abortedPromise = runAntigravityAcpTurn({
    member: { agent: 'antigravity', providerId: 'sess-desktop-2', cwd: tmpDir() },
    message: '卡住',
    agyBin: process.execPath,
    spawnFn: makeMockSpawn({ hangPrompt: true }),
    onStart: (h) => { stopper = h; },
    onLine: (line) => {
      if (line.includes('conversation.started')) {
        setTimeout(() => stopper?.kill(), 20);
      }
    },
  });
  let settled = false;
  abortedPromise.then(() => { settled = true; });
  const close = await killSent.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, '仅发出 kill 时不能释放执行句柄');
  close();
  const aborted = await abortedPromise;
  assert.equal(aborted.summary.status, 'aborted');
  assert.ok(seenRpcs.some((r) => r.method === 'session/cancel' && r.params.sessionId === 'sess-desktop-2'));
});

test('createSession：识别 Antigravity CLI init 事件并即时落地会话', async () => {
  const dir = tmpDir('baton-agy-create-');
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const convId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const transcript = writeJsonl(dir, `antigravity-cli/brain/${convId}/.system_generated/logs/transcript.jsonl`, [
    { step_index: 0, type: 'USER_INPUT', created_at: new Date().toISOString(), content: '<USER_REQUEST>\nhi\n</USER_REQUEST>' },
  ]);
  const member = {
    key: `antigravity:${convId}`,
    agent: 'antigravity',
    providerId: convId,
    cwd: ws,
    file: transcript,
  };
  const repo = {
    listChains: () => [{ members: [member] }],
    getSession: (k) => (k === member.key ? member : null),
  };

  let releaseTurn;
  const created = await createSession({
    repo,
    config: { allowSend: true, workspacesRoot: dir },
    agent: 'antigravity',
    cwd: ws,
    message: '你好',
    prefs: { set: () => {}, defaultEffort: () => null },
    audit: () => {},
    turns: { start: () => {}, end: () => {}, latest: () => null },
    queue: { enqueue: () => {}, takeNext: () => null, list: () => [] },
    push: { send: async () => {} },
    runner: ({ onLine }) => new Promise((resolve) => {
      onLine(JSON.stringify({ event: 'init', conversation_id: convId }));
      releaseTurn = () => resolve({ summary: { status: 'ok', sessionId: convId, eventCount: 1, tokens: null } });
    }),
  });

  assert.equal(created.status, 202);
  assert.equal(created.body.sessionId, convId);
  assert.equal(created.body.key, member.key);
  releaseTurn?.();
  await created.settled;
});
