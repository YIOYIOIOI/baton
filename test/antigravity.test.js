import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

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
import { antigravitySessionFiles, sessionRef } from '../src/providers.js';
import { createRepo } from '../src/repo.js';
import { eventsFor } from '../src/wire.js';
import { liveStates } from '../src/runtime/live.js';
import { clearInfoCache, fileEdits, readSessionInfo } from '../src/sessioninfo.js';
import { antigravityCommands, clearCommandCache } from '../src/agent/commands.js';
import {
  callBridge,
  ensureAntigravityPlugin,
  findLiveBridge,
  resolveAntigravityProjectId,
} from '../src/agent/antigravityBridge.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { BRIDGE_OR_CLI_MISSING_MSG, runAntigravityAcpTurn, runAntigravityTurn } from '../src/agent/antigravityRun.js';
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

  const first = ensureAntigravityPlugin({ geminiConfigDir });
  assert.equal(first.changed, true);
  assert.ok(fs.existsSync(path.join(first.destDir, 'plugin.json')));
  assert.ok(fs.existsSync(path.join(first.destDir, 'sidecars', 'bridge', 'main.mjs')));
  assert.equal(fs.readFileSync(cfgPath, 'utf8'), '{"custom":1}', '绝不改写用户的 config.json');

  const second = ensureAntigravityPlugin({ geminiConfigDir });
  assert.equal(second.changed, false);

  const ws = path.join(root, 'repo-one');
  fs.mkdirSync(ws, { recursive: true });
  const createdId = resolveAntigravityProjectId(ws, { geminiConfigDir, createIfMissing: true });
  assert.ok(createdId);
  assert.equal(resolveAntigravityProjectId(ws, { geminiConfigDir }), createdId);

  const batonDir = path.join(root, '.baton');
  fs.mkdirSync(path.join(batonDir, 'antigravity-bridges'), { recursive: true });
  fs.writeFileSync(path.join(batonDir, 'token'), 'secret-tok');

  const received = [];
  const srv = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer secret-tok') {
      res.writeHead(401).end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      received.push({ url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  try {
    fs.writeFileSync(
      path.join(batonDir, 'antigravity-bridges', '999999.json'),
      JSON.stringify({ pid: 999999, port: 1, projectId: createdId }),
    );
    fs.writeFileSync(
      path.join(batonDir, 'antigravity-bridges', `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, port, projectId: createdId, startedAt: new Date().toISOString() }),
    );

    const live = await findLiveBridge({
      batonDir,
      projectId: createdId,
      alive: (pid) => pid === process.pid,
    });
    assert.equal(live?.port, port);
    assert.equal(fs.existsSync(path.join(batonDir, 'antigravity-bridges', '999999.json')), false, '死 PID 登记应被清理');

    const sent = await callBridge(live, '/send-message', { body: { conversationId: 'c1', message: 'hi' } });
    assert.equal(sent.ok, true);
    assert.deepEqual(received.map((r) => r.url), ['/health', '/send-message']);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
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
    { id: 'conv-x', title: 'Test', status: 'CASCADE_RUN_STATUS_RUNNING', lastModifiedTime: new Date().toISOString() },
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

test('runAntigravityAcpTurn：ACP JSON-RPC 流程、切档切模型以及 session/cancel 中止', async () => {
  const seenRpcs = [];
  const makeMockSpawn = ({ hangPrompt = false } = {}) => (_cmd, _args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      process.nextTick(() => child.emit('close', 0));
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
    member: { agent: 'antigravity', providerId: 'sess-desktop-1', cwd: 'C:\\repo' },
    message: '你好',
    model: 'gemini-4-carbon',
    effort: 'high',
    permissionMode: 'plan',
    product: 'antigravity',
    agyBin: 'mock-agy',
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
    member: { agent: 'antigravity', providerId: 'sess-desktop-2', cwd: 'C:\\repo' },
    message: '卡住',
    agyBin: 'mock-agy',
    spawnFn: makeMockSpawn({ hangPrompt: true }),
    onStart: (h) => { stopper = h; },
    onLine: (line) => {
      if (line.includes('conversation.started')) {
        setTimeout(() => stopper?.kill(), 20);
      }
    },
  });
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
