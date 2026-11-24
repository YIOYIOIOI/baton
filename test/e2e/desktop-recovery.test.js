import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { tmpDir, writeJsonl } from '../helpers.js';
import { eventually, project, unusedPort } from './host.mjs';

test('未知的新建回执可跨正常关机查询，接管者只观察，身份确认后绑定原始轮次', { timeout: 45_000 }, async (t) => {
  const root = tmpDir();
  const home = tmpDir();
  const workspace = tmpDir();
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(root, 'token'), token);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ allowSend: true, workspacesRoot: workspace }));
  const env = {
    SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, BATON_DIR: root, LOCALAPPDATA: home,
    APPDATA: home, TEMP: home, TMP: home, PATH: '', BATON_NO_CLI_PROBES: '1', ANTHROPIC_AUTH_TOKEN: 'test-only',
  };
  const live = new Set();
  function start(args, extra = {}) {
    const child = spawn(process.execPath, args, { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], ...extra });
    live.add(child);
    child.stdout.resume();
    child.stderr.resume();
    child.once('exit', () => live.delete(child));
    return child;
  }
  t.after(async () => Promise.all([...live].map(async (child) => { const done = once(child, 'exit'); child.kill(); await done; })));
  const sidecarFile = path.join(project, 'sidecars/baton-bridge/sidecars/bridge/main.mjs');
  fs.writeFileSync(path.join(workspace, 'agentapi'), [
    "require('node:fs').appendFileSync('dispatch-count', '1');", "process.exitCode = 1;",
  ].join('\n'));
  const sidecar = start([sidecarFile], { env: { ...env, ANTIGRAVITY_AGENTAPI_EXE: process.execPath } });
  await eventually(() => fs.existsSync(path.join(root, 'antigravity-bridges', sidecar.pid + '.json')));
  const port = await unusedPort();
  const base = 'http://127.0.0.1:' + port;
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  async function daemon() {
    const child = start(['--import', pathToFileURL(path.join(import.meta.dirname, '../fixtures/graceful-daemon-signal.mjs')).href,
      path.join(project, 'src/cli.js'), 'start', '--port', String(port)]);
    await eventually(async () => { try { return (await fetch(base + '/api/health', { headers })).ok; } catch { return false; } });
    return child;
  }
  const first = await daemon();
  const text = '恢复观察之前的桌面新建';
  async function create(message) {
    const accepted = await fetch(base + '/api/sessions', {
      method: 'POST', headers, body: JSON.stringify({ agent: 'antigravity', cwd: workspace, message }), signal: AbortSignal.timeout(10_000),
    });
    assert.equal(accepted.status, 202);
    return accepted.json();
  }
  const sameText = '同目录且首句相同的两项任务';
  const interruptedText = '首轮已在紧凑日志名下登记';
  const [receipt, interrupted, ...ambiguous] = await Promise.all([text, interruptedText, sameText, sameText].map(create));
  assert.equal(receipt.status, 'unconfirmed');
  assert.equal(receipt.key, null);
  assert.equal(receipt.sessionId, null);
  assert.ok(receipt.statusUrl.endsWith(receipt.turnId));
  const status = async (r = receipt) => (await fetch(base + r.statusUrl, { headers })).json();
  assert.equal((await status()).status, 'unconfirmed');
  const gemini = path.join(home, '.gemini', 'antigravity');
  function publish(id, cwd, prompt, name = 'transcript.jsonl') {
    writeJsonl(gemini, 'brain/' + id + '/.system_generated/logs/' + name, [
      { step_index: 0, type: 'USER_INPUT', content: prompt },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: '宿主完成', output_tokens: 6 },
    ]);
    const db = new DatabaseSync(path.join(gemini, 'conversation_summaries.db'));
    try {
      db.exec('CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id TEXT PRIMARY KEY, title, workspace_uris, project_id, status, not_fully_idle, nesting_depth, killed, parent_conversation_id, last_modified_time)');
      db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, 0, 0, 0, NULL, ?)').run(
        id, '', JSON.stringify([cwd]), '', 'CASCADE_RUN_STATUS_IDLE', new Date().toISOString());
    } finally { db.close(); }
  }
  publish('shared-candidate', workspace, sameText);
  publish('wrong-directory', tmpDir(), text);
  await delay(850);
  assert.deepEqual((await Promise.all([receipt, interrupted, ...ambiguous].map(status))).map((r) => r.status), Array(4).fill('unconfirmed'));
  const exited = once(first, 'exit');
  first.send('shutdown');
  await eventually(() => first.exitCode !== null, 7000);
  assert.equal((await exited)[0], 0);

  // A previous daemon wrote its first turn, then exited before updating the receipt.
  // Older reservations already pin the desktop identity but have no transcript key.
  const id = 'interrupted', prefix = 'antigravity/brain/' + id + '/.system_generated/logs/';
  const keyFor = (file) => 'antigravity:' + Buffer.from(prefix + file).toString('base64url');
  const compact = keyFor('transcript.jsonl'), full = keyFor('transcript_full.jsonl');
  const receiptFile = path.join(root, 'session-creations', interrupted.turnId + '.json');
  const inflight = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  fs.writeFileSync(receiptFile, JSON.stringify({ ...inflight, reservation: { directory: 'antigravity', sessionId: id } }));
  const compactRun = path.join(root, 'runs', encodeURIComponent(compact), interrupted.turnId + '.json');
  fs.mkdirSync(path.dirname(compactRun), { recursive: true });
  fs.writeFileSync(compactRun, JSON.stringify({ key: compact, turnId: interrupted.turnId, agent: 'antigravity', prompt: interruptedText,
    status: 'running', startedAt: inflight.startedAt, ownerId: inflight.ownerId, canStop: false,
    monitor: { conversationId: id, directory: 'antigravity', baselineStep: -1, userStep: 0, sawRunning: true, awaitingIdle: false } }));
  publish(id, workspace, interruptedText, 'transcript_full.jsonl');
  await daemon();
  assert.equal((await status()).status, 'unconfirmed');
  publish('recovered', workspace, text);
  const bound = await eventually(async () => { const value = await status(); return value.key ? value : null; });
  assert.equal(bound.turnId, receipt.turnId);
  assert.equal(bound.sessionId, 'recovered');
  const runFile = path.join(root, 'runs', encodeURIComponent(bound.key), receipt.turnId + '.json');
  const run = await eventually(() => {
    const record = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    return record.status === 'ok' && record;
  });
  assert.equal(run.tokens.output, 6);
  await eventually(async () => (await status(interrupted)).key === full);
  assert.equal(JSON.parse(fs.readFileSync(receiptFile, 'utf8')).key, compact);
  const original = JSON.parse(fs.readFileSync(compactRun, 'utf8'));
  assert.equal(original.status, 'ok');
  assert.equal(original.tokens.output, 6);
  assert.equal(fs.existsSync(path.join(root, 'runs', encodeURIComponent(full), interrupted.turnId + '.json')), false);
  assert.deepEqual((await Promise.all(ambiguous.map(status))).map((r) => r.status), ['unconfirmed', 'unconfirmed']);
  assert.equal(fs.readFileSync(path.join(workspace, 'dispatch-count'), 'utf8'), '1111');
});
